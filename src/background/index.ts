// Background service worker (ES module). Wires Chrome events to the pure v1
// state machine (./state), storage (./storage), DNR rules (./rules), and alarms
// (./alarms). `Date.now()` is read only here (and in storage init) and passed
// into the pure functions. Species data is loaded ONCE (module-cached) via
// loadSpeciesData().
import type {
  Request,
  PayEntryResponse,
  SpareResponse,
  ActionResponse,
} from '../shared/messages';
import type { Settings, GameState, FullState } from '../shared/types';
import type { SpeciesData } from '../shared/species';
import { DEFAULT_SETTINGS, ALARMS } from '../shared/constants';
import { normalizeDomain } from '../shared/domains';
import { loadSpeciesData } from '../shared/species';
import {
  reconcile,
  isInLockout,
  deriveState,
  payEntry,
  clampPartyHp,
  setGuardian,
  pickStarter,
  buyEgg,
  ackEvolution,
} from './state';
import { ensureInitialized, mutate, loadSettings } from './storage';
import {
  rebuildRules,
  disableRuleForDomain,
  enableRuleForDomain,
  restoreAllExcept,
} from './rules';
import {
  scheduleDailyRollover,
  scheduleGraceExpiry,
  clearAllGraceAlarms,
  graceDomainFromAlarmName,
} from './alarms';

// ---------------------------------------------------------------------------
// Species data (module-cached; loadSpeciesData caches internally too).
// ---------------------------------------------------------------------------

let speciesCache: SpeciesData | null = null;

async function species(): Promise<SpeciesData> {
  if (speciesCache) return speciesCache;
  speciesCache = await loadSpeciesData();
  return speciesCache;
}

// ---------------------------------------------------------------------------
// Bootstrap (install + startup): migrate, reconcile, rebuild rules, alarms.
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  await ensureInitialized();
  const sp = await species();
  const now = Date.now();

  const { settings, state } = await mutate(async (ctx) => {
    const reconciled = reconcile(ctx.state, ctx.settings, sp, now);
    return { state: reconciled, result: { settings: ctx.settings, state: reconciled } };
  });

  // Rebuild all rules from the blocklist, then honor live grace passes by
  // disabling those domains' rules.
  await rebuildRules(settings.blocklist);
  for (const domain of Object.keys(state.gracePasses)) {
    await disableRuleForDomain(settings.blocklist, domain);
  }

  scheduleDailyRollover();

  // Reschedule grace-expiry alarms for any live passes (SW may have missed them).
  for (const [domain, expiresAt] of Object.entries(state.gracePasses)) {
    scheduleGraceExpiry(domain, expiresAt);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap().catch((e) => console.error('[dodgy] onInstalled bootstrap failed', e));
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap().catch((e) => console.error('[dodgy] onStartup bootstrap failed', e));
});

// ---------------------------------------------------------------------------
// Alarm handlers.
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  handleAlarm(alarm).catch((e) => console.error('[dodgy] alarm handler failed', alarm.name, e));
});

async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  const sp = await species();
  const now = Date.now();

  if (alarm.name === ALARMS.dailyRollover) {
    const { settings, state } = await mutate(async (ctx) => {
      const reconciled = reconcile(ctx.state, ctx.settings, sp, now);
      return { state: reconciled, result: { settings: ctx.settings, state: reconciled } };
    });
    // Rebuild all rules (midnight ends any lockout), then re-disable live passes.
    await rebuildRules(settings.blocklist);
    for (const domain of Object.keys(state.gracePasses)) {
      await disableRuleForDomain(settings.blocklist, domain);
    }
    scheduleDailyRollover();
    return;
  }

  const graceDomain = graceDomainFromAlarmName(alarm.name);
  if (graceDomain != null) {
    // Drop the (now-expired) pass defensively, then re-block the domain — but
    // only when NOT in lockout (during lockout everything stays blocked).
    const { settings, locked } = await mutate(async (ctx) => {
      const reconciled = reconcile(ctx.state, ctx.settings, sp, now);
      return {
        state: reconciled,
        result: { settings: ctx.settings, locked: isInLockout(reconciled, now) },
      };
    });
    if (!locked) {
      await enableRuleForDomain(settings.blocklist, graceDomain);
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Message handling.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
  handle(request)
    .then(sendResponse)
    .catch((e) => {
      console.error('[dodgy] message handler failed', request, e);
      sendResponse(undefined);
    });
  return true; // keep the channel open for async work
});

async function handle(
  request: Request,
): Promise<FullState | PayEntryResponse | SpareResponse | ActionResponse | undefined> {
  const now = Date.now();

  switch (request.type) {
    case 'GET_STATE':
      return handleGetState(now);
    case 'PAY_ENTRY':
      return handlePayEntry(request.domain, now);
    case 'SPARE':
      return handleSpare();
    case 'UPDATE_SETTINGS':
      return handleUpdateSettings(request.settings, now);
    case 'RESET_BLOCKLIST':
      return handleResetBlocklist(now);
    case 'PICK_STARTER':
      return handlePickStarter(request.species, now);
    case 'SET_GUARDIAN':
      return handleSetGuardian(request.monId, now);
    case 'BUY_EGG':
      return handleBuyEgg(request.species, now);
    case 'ACK_EVOLUTION':
      return handleAckEvolution(request.monId, now);
    default:
      return undefined;
  }
}

function fullState(
  settings: Settings,
  state: GameState,
  sp: SpeciesData,
  now: number,
): FullState {
  return { settings, state, derived: deriveState(state, settings, sp, now) };
}

// ---------------------------------------------------------------------------
// GET_STATE
// ---------------------------------------------------------------------------

async function handleGetState(now: number): Promise<FullState> {
  const sp = await species();
  const { settings, state, expiredPasses } = await mutate(async (ctx) => {
    const before = new Set(Object.keys(ctx.state.gracePasses));
    const reconciled = reconcile(ctx.state, ctx.settings, sp, now);
    const after = new Set(Object.keys(reconciled.gracePasses));
    const expired = [...before].filter((d) => !after.has(d));
    return {
      state: reconciled,
      result: { settings: ctx.settings, state: reconciled, expiredPasses: expired },
    };
  });

  // Opportunistic, minimal rule fix: if not in lockout, re-block any domain
  // whose pass just expired during this reconcile.
  if (!isInLockout(state, now)) {
    for (const domain of expiredPasses) {
      await enableRuleForDomain(settings.blocklist, domain);
    }
  }

  return fullState(settings, state, sp, now);
}

// ---------------------------------------------------------------------------
// PAY_ENTRY
// ---------------------------------------------------------------------------

type PayMutateResult =
  | { kind: 'locked'; state: GameState }
  | {
      kind: 'result';
      state: GameState;
      outcome: 'granted' | 'faint' | 'permadeath' | 'no-guardian';
      graceExpiresAt: number;
    };

async function handlePayEntry(rawDomain: string, now: number): Promise<PayEntryResponse> {
  const sp = await species();
  const domain = normalizeDomain(rawDomain);

  const outcome = await mutate<PayMutateResult>(async (ctx) => {
    const state = reconcile(ctx.state, ctx.settings, sp, now);

    // Lockout guard: if in lockout and this domain does NOT already hold a grace
    // pass, do NOT mutate state. The gate owns the lockout wall; this is a
    // defensive no-op returning current state unchanged.
    const hasPass = state.gracePasses[domain] != null;
    if (isInLockout(state, now) && !hasPass) {
      return { state, result: { kind: 'locked', state } };
    }

    const res = payEntry(state, ctx.settings, sp, domain, now);
    return {
      state: res.state,
      result: {
        kind: 'result',
        state: res.state,
        outcome: res.outcome,
        graceExpiresAt: res.graceExpiresAt,
      },
    };
  });

  const settings = await loadSettings();

  if (outcome.kind === 'locked') {
    // No-op response: no damage applied. Report 'locked' (contract).
    const existing = outcome.state.gracePasses[domain] ?? 0;
    return {
      outcome: 'locked',
      hp: guardianHp(outcome.state),
      faintStreak: guardianFaintStreak(outcome.state),
      lockoutUntil: lockoutUntilFor(outcome.state, now),
      graceExpiresAt: existing,
      redirect: false,
      partyEmpty: outcome.state.party.length === 0,
    };
  }

  if (outcome.outcome === 'no-guardian') {
    // Nothing guarded the entry: no damage, always let them through.
    return {
      outcome: 'no-guardian',
      hp: 0,
      faintStreak: 0,
      lockoutUntil: null,
      graceExpiresAt: outcome.graceExpiresAt,
      redirect: true,
      partyEmpty: outcome.state.party.length === 0,
    };
  }

  if (outcome.outcome === 'granted') {
    await disableRuleForDomain(settings.blocklist, domain);
    scheduleGraceExpiry(domain, outcome.graceExpiresAt);
    scheduleDailyRollover();
    return {
      outcome: 'granted',
      hp: guardianHp(outcome.state),
      faintStreak: guardianFaintStreak(outcome.state),
      lockoutUntil: null,
      graceExpiresAt: outcome.graceExpiresAt,
      redirect: true,
      partyEmpty: false,
    };
  }

  // FAINT or PERMADEATH: mirror the v0.4 death DNR flow. The fatal hit is still
  // honored — this domain keeps its live pass; every OTHER domain re-blocks into
  // the lockout wall until midnight. Clear all other grace alarms, keep the
  // fatal domain's own.
  await restoreAllExcept(settings.blocklist, domain);
  await disableRuleForDomain(settings.blocklist, domain);
  await clearAllGraceAlarms(domain);
  scheduleGraceExpiry(domain, outcome.graceExpiresAt);
  scheduleDailyRollover();

  return {
    outcome: outcome.outcome, // 'faint' | 'permadeath'
    hp: guardianHp(outcome.state),
    faintStreak: guardianFaintStreak(outcome.state),
    lockoutUntil: lockoutUntilFor(outcome.state, now),
    graceExpiresAt: outcome.graceExpiresAt,
    redirect: true,
    partyEmpty: outcome.state.party.length === 0,
  };
}

/** hp of the active guardian, or 0 when none. */
function guardianHp(state: GameState): number {
  const g = state.party.find((m) => m.id === state.activeGuardianId);
  return g ? g.hp : 0;
}

/** faintStreak of the active guardian, or 0 when none. */
function guardianFaintStreak(state: GameState): number {
  const g = state.party.find((m) => m.id === state.activeGuardianId);
  return g ? g.faintStreak : 0;
}

/** Derived lockout-until (next local midnight) or null. */
function lockoutUntilFor(state: GameState, now: number): number | null {
  return isInLockout(state, now) ? nextMidnight(now) : null;
}

function nextMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// SPARE
// ---------------------------------------------------------------------------

async function handleSpare(): Promise<SpareResponse> {
  // No state change: the user backed off. Return ok so the gate can navigate away.
  return { ok: true };
}

// ---------------------------------------------------------------------------
// UPDATE_SETTINGS
// ---------------------------------------------------------------------------

/** Clamp a numeric field to at least `min` (coerce invalid/NaN to min). */
function clampMin(value: number, min: number): number {
  return Number.isFinite(value) && value >= min ? value : min;
}

/**
 * Clamp a numeric field to the inclusive [min, max] range, rounding to an
 * integer; coerce invalid/NaN to `fallback`.
 */
function clampRange(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function validateSettings(raw: Settings): Settings {
  const seen = new Set<string>();
  const blocklist: string[] = [];
  for (const entry of raw.blocklist ?? []) {
    const d = normalizeDomain(entry);
    if (d && !seen.has(d)) {
      seen.add(d);
      blocklist.push(d);
    }
  }

  // pokedexTitle: trimmed, non-empty, <= 24 chars, else default.
  const rawTitle = typeof raw.pokedexTitle === 'string' ? raw.pokedexTitle.trim() : '';
  const pokedexTitle =
    rawTitle.length > 0 && rawTitle.length <= 24 ? rawTitle : DEFAULT_SETTINGS.pokedexTitle;

  return {
    ...raw,
    // v0.4 / shared numerics.
    maxHp: clampMin(raw.maxHp, 1),
    damagePerEntry: clampMin(raw.damagePerEntry, 1),
    chaseDifficulty: clampRange(raw.chaseDifficulty, 1, 10, DEFAULT_SETTINGS.chaseDifficulty),
    levelUpThreshold: clampMin(raw.levelUpThreshold, 1),
    graceMinutes: clampMin(raw.graceMinutes, 0),
    // v1 numerics.
    starterLevel: clampMin(raw.starterLevel, 1),
    faintLevelPenalty: clampMin(raw.faintLevelPenalty, 0),
    faintStreakToPermadeath: clampMin(raw.faintStreakToPermadeath, 1),
    baseReward: clampMin(raw.baseReward, 0),
    eggCost: clampMin(raw.eggCost, 1),
    daysToHatch: clampMin(raw.daysToHatch, 1),
    pokedexTitle,
    blocklist,
  };
}

async function handleUpdateSettings(raw: Settings, now: number): Promise<FullState> {
  const sp = await species();
  const newSettings = validateSettings(raw);

  const { settings, state } = await mutate(async (ctx) => {
    const clamped = clampPartyHp(ctx.state, newSettings);
    const reconciled = reconcile(clamped, newSettings, sp, now);
    return {
      settings: newSettings,
      state: reconciled,
      result: { settings: newSettings, state: reconciled },
    };
  });

  await rebuildRules(settings.blocklist);
  for (const domain of Object.keys(state.gracePasses)) {
    await disableRuleForDomain(settings.blocklist, domain);
  }

  return fullState(settings, state, sp, now);
}

// ---------------------------------------------------------------------------
// RESET_BLOCKLIST
// ---------------------------------------------------------------------------

async function handleResetBlocklist(now: number): Promise<FullState> {
  const sp = await species();
  const { settings, state } = await mutate(async (ctx) => {
    const newSettings: Settings = {
      ...ctx.settings,
      blocklist: [...DEFAULT_SETTINGS.blocklist],
    };
    return {
      settings: newSettings,
      result: { settings: newSettings, state: ctx.state },
    };
  });

  await rebuildRules(settings.blocklist);
  for (const domain of Object.keys(state.gracePasses)) {
    await disableRuleForDomain(settings.blocklist, domain);
  }

  return fullState(settings, state, sp, now);
}

// ---------------------------------------------------------------------------
// v1 party / egg / evolution actions.
// ---------------------------------------------------------------------------

async function handlePickStarter(speciesId: string, now: number): Promise<ActionResponse> {
  const sp = await species();
  const { settings, state, error } = await mutate(async (ctx) => {
    const reconciled = reconcile(ctx.state, ctx.settings, sp, now);
    const res = pickStarter(reconciled, ctx.settings, sp, speciesId, now);
    return {
      state: res.state,
      result: { settings: ctx.settings, state: res.state, error: res.error },
    };
  });
  return actionResponse(settings, state, sp, now, error);
}

async function handleSetGuardian(monId: string, now: number): Promise<ActionResponse> {
  const sp = await species();
  const { settings, state, error } = await mutate(async (ctx) => {
    const reconciled = reconcile(ctx.state, ctx.settings, sp, now);
    const res = setGuardian(reconciled, monId, now);
    return {
      state: res.state,
      result: { settings: ctx.settings, state: res.state, error: res.error },
    };
  });
  return actionResponse(settings, state, sp, now, error);
}

async function handleBuyEgg(speciesId: string, now: number): Promise<ActionResponse> {
  const sp = await species();
  const { settings, state, error } = await mutate(async (ctx) => {
    const reconciled = reconcile(ctx.state, ctx.settings, sp, now);
    const res = buyEgg(reconciled, ctx.settings, sp, speciesId);
    return {
      state: res.state,
      result: { settings: ctx.settings, state: res.state, error: res.error },
    };
  });
  return actionResponse(settings, state, sp, now, error);
}

async function handleAckEvolution(monId: string, now: number): Promise<ActionResponse> {
  const sp = await species();
  const { settings, state, error } = await mutate(async (ctx) => {
    const reconciled = reconcile(ctx.state, ctx.settings, sp, now);
    const res = ackEvolution(reconciled, monId);
    return {
      state: res.state,
      result: { settings: ctx.settings, state: res.state, error: res.error },
    };
  });
  return actionResponse(settings, state, sp, now, error);
}

function actionResponse(
  settings: Settings,
  state: GameState,
  sp: SpeciesData,
  now: number,
  error: ActionResponse['reason'] | undefined,
): ActionResponse {
  return {
    ok: error === undefined,
    ...(error !== undefined ? { reason: error } : {}),
    state: fullState(settings, state, sp, now),
  };
}
