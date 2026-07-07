// Background service worker (ES module). Wires Chrome events to the pure state
// machine (./state), storage (./storage), DNR rules (./rules), and alarms
// (./alarms). `Date.now()` is read only here (and in storage init) and passed
// into the pure functions.
import type {
  Request,
  PayEntryResponse,
  SpareResponse,
} from '../shared/messages';
import type { Settings, PetState, FullState } from '../shared/types';
import { DEFAULT_SETTINGS, ALARMS } from '../shared/constants';
import { normalizeDomain } from '../shared/domains';
import {
  reconcile,
  isInLockout,
  deriveState,
  payEntry,
  clampHpToSettings,
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
  scheduleLockoutEnd,
  scheduleGraceExpiry,
  clearAllGraceAlarms,
  graceDomainFromAlarmName,
} from './alarms';

// ---------------------------------------------------------------------------
// Bootstrap (install + startup): reconcile, rebuild rules, reschedule alarms.
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  await ensureInitialized();
  const now = Date.now();

  const { settings, state } = await mutate(async (ctx) => {
    const reconciled = reconcile(ctx.state, ctx.settings, now);
    return { state: reconciled, result: { settings: ctx.settings, state: reconciled } };
  });

  // Rebuild all rules from the blocklist, then honor live grace passes by
  // disabling those domains' rules.
  await rebuildRules(settings.blocklist);
  for (const domain of Object.keys(state.gracePasses)) {
    await disableRuleForDomain(settings.blocklist, domain);
  }

  scheduleDailyRollover();

  if (isInLockout(state, now) && state.lockoutUntil != null) {
    scheduleLockoutEnd(state.lockoutUntil);
  }

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
  const now = Date.now();

  if (alarm.name === ALARMS.dailyRollover) {
    const { settings, state } = await mutate(async (ctx) => {
      const reconciled = reconcile(ctx.state, ctx.settings, now);
      return { state: reconciled, result: { settings: ctx.settings, state: reconciled } };
    });
    // Rebuild all rules, then re-disable domains with live passes.
    await rebuildRules(settings.blocklist);
    for (const domain of Object.keys(state.gracePasses)) {
      await disableRuleForDomain(settings.blocklist, domain);
    }
    scheduleDailyRollover();
    return;
  }

  if (alarm.name === ALARMS.lockoutEnd) {
    const { settings, state } = await mutate(async (ctx) => {
      const reconciled = reconcile(ctx.state, ctx.settings, now);
      return { state: reconciled, result: { settings: ctx.settings, state: reconciled } };
    });
    // All enabled, minus any live grace passes.
    await rebuildRules(settings.blocklist);
    for (const domain of Object.keys(state.gracePasses)) {
      await disableRuleForDomain(settings.blocklist, domain);
    }
    // If somehow still locked (clock skew), reschedule.
    if (isInLockout(state, now) && state.lockoutUntil != null) {
      scheduleLockoutEnd(state.lockoutUntil);
    }
    return;
  }

  const graceDomain = graceDomainFromAlarmName(alarm.name);
  if (graceDomain != null) {
    // Drop the (now-expired) pass defensively, then re-block the domain.
    const { settings } = await mutate(async (ctx) => {
      const reconciled = reconcile(ctx.state, ctx.settings, now);
      return { state: reconciled, result: { settings: ctx.settings, state: reconciled } };
    });
    await enableRuleForDomain(settings.blocklist, graceDomain);
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
): Promise<FullState | PayEntryResponse | SpareResponse | undefined> {
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
    default:
      return undefined;
  }
}

function fullState(settings: Settings, state: PetState, now: number): FullState {
  return { settings, state, derived: deriveState(state, settings, now) };
}

async function handleGetState(now: number): Promise<FullState> {
  const { settings, state, expiredPasses } = await mutate(async (ctx) => {
    const before = new Set(Object.keys(ctx.state.gracePasses));
    const reconciled = reconcile(ctx.state, ctx.settings, now);
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

  return fullState(settings, state, now);
}

async function handlePayEntry(rawDomain: string, now: number): Promise<PayEntryResponse> {
  const domain = normalizeDomain(rawDomain);

  const outcome = await mutate<
    | { kind: 'locked'; state: PetState }
    | { kind: 'result'; state: PetState; outcome: 'granted' | 'death'; graceExpiresAt: number }
  >(async (ctx) => {
    const state = reconcile(ctx.state, ctx.settings, now);

    // Lockout guard: if in lockout and this domain does NOT already hold a grace
    // pass, do NOT mutate state (paying during lockout must not apply damage).
    // The gate owns the lockout wall and should not call PAY_ENTRY in this case;
    // this is a defensive no-op that returns current state unchanged.
    const hasPass = state.gracePasses[domain] != null;
    if (isInLockout(state, now) && !hasPass) {
      return { state, result: { kind: 'locked', state } };
    }

    const res = payEntry(state, ctx.settings, domain, now);
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
    // No-op response: no damage applied. graceExpiresAt reflects any existing
    // pass for this domain, else 0.
    const existing = outcome.state.gracePasses[domain] ?? 0;
    return {
      outcome: 'granted',
      hp: outcome.state.hp,
      lockoutUntil: outcome.state.lockoutUntil,
      graceExpiresAt: existing,
      redirect: true,
    };
  }

  if (outcome.outcome === 'granted') {
    await disableRuleForDomain(settings.blocklist, domain);
    scheduleGraceExpiry(domain, outcome.graceExpiresAt);
    scheduleDailyRollover();
    return {
      outcome: 'granted',
      hp: outcome.state.hp,
      lockoutUntil: null,
      graceExpiresAt: outcome.graceExpiresAt,
      redirect: true,
    };
  }

  // DEATH. Fatal hit honored: this domain keeps its pass (rule disabled); every
  // OTHER domain re-blocks into the lockout wall.
  await restoreAllExcept(settings.blocklist, domain);
  await disableRuleForDomain(settings.blocklist, domain); // fatal domain's pass is live
  await clearAllGraceAlarms(domain);
  scheduleGraceExpiry(domain, outcome.graceExpiresAt); // fatal domain's own pass alarm
  if (outcome.state.lockoutUntil != null) {
    scheduleLockoutEnd(outcome.state.lockoutUntil);
  }

  return {
    outcome: 'death',
    hp: 0,
    lockoutUntil: outcome.state.lockoutUntil,
    graceExpiresAt: outcome.graceExpiresAt,
    redirect: true,
  };
}

async function handleSpare(): Promise<SpareResponse> {
  // No state change: the user backed off. Return ok so the gate can navigate away.
  return { ok: true };
}

/** Clamp a numeric field to at least `min` (coerce invalid/NaN to min). */
function clampMin(value: number, min: number): number {
  return Number.isFinite(value) && value >= min ? value : min;
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
  return {
    maxHp: clampMin(raw.maxHp, 1),
    damagePerEntry: clampMin(raw.damagePerEntry, 1),
    levelUpThreshold: clampMin(raw.levelUpThreshold, 1),
    levelsPerEvolution: clampMin(raw.levelsPerEvolution, 1),
    graceMinutes: clampMin(raw.graceMinutes, 0),
    lockoutHours: clampMin(raw.lockoutHours, 1),
    blocklist,
  };
}

async function handleUpdateSettings(raw: Settings, now: number): Promise<FullState> {
  const newSettings = validateSettings(raw);

  const { settings, state } = await mutate(async (ctx) => {
    const clamped = clampHpToSettings(ctx.state, newSettings);
    const reconciled = reconcile(clamped, newSettings, now);
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

  return fullState(settings, state, now);
}

async function handleResetBlocklist(now: number): Promise<FullState> {
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

  return fullState(settings, state, now);
}
