// v1 (Pokémon) pure state machine. Every function is side-effect-free and
// time-injected: no chrome APIs, no Date.now() inside — the caller passes `now`
// (epoch ms). Every stage-aware function also takes an already-loaded
// SpeciesData so the whole module is trivially unit-testable with the fixture.
import type {
  Settings,
  GameState,
  PartyMember,
  DerivedState,
} from '../shared/types';
import type { SpeciesData } from '../shared/species';
import {
  lineFor,
  stageIndexForLevel,
  stageMinLevel,
  nextEvolutionLevel as nextEvoLevel,
} from '../shared/species';

// ---------------------------------------------------------------------------
// Time helpers (pure)
// ---------------------------------------------------------------------------

/** Returns local-timezone YYYY-MM-DD for the given epoch ms. */
export function localDateString(now: number): string {
  const d = new Date(now);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Epoch ms of the next local midnight strictly after `now`. */
export function nextLocalMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0); // rolls into tomorrow at local 00:00:00.000
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** Initial state on install / after migration. */
export function freshState(_settings: Settings, now: number): GameState {
  return {
    schemaVersion: 1,
    coins: 0,
    party: [],
    activeGuardianId: null,
    guardianLockedToday: false,
    faintedTodayDate: null,
    incubator: null,
    paidEntriesToday: 0,
    lastRegenDate: localDateString(now),
    gracePasses: {},
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The active guardian member, or null. */
function findGuardian(state: GameState): PartyMember | null {
  if (state.activeGuardianId == null) return null;
  return state.party.find((m) => m.id === state.activeGuardianId) ?? null;
}

/** true iff today's guardian fainted today (emergent lockout until midnight). */
export function isInLockout(state: GameState, now: number): boolean {
  return state.faintedTodayDate === localDateString(now);
}

/** Prune grace passes whose expiry is at/after now removed. */
function pruneGracePasses(
  passes: Record<string, number>,
  now: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [domain, expiry] of Object.entries(passes)) {
    if (expiry > now) out[domain] = expiry;
  }
  return out;
}

/** Max hp a member should hold (flat model — settings.maxHp). */
function memberMaxHp(settings: Settings): number {
  return settings.maxHp;
}

// ---------------------------------------------------------------------------
// Reconcile (idempotent day rollover)
// ---------------------------------------------------------------------------

/**
 * Prune expired grace passes and, when the calendar day has advanced past
 * lastRegenDate, apply the day-end rollover. A multi-day gap counts as ONE
 * qualifying block (v0.4 semantics). Idempotent: calling twice the same day is
 * a no-op beyond grace-pass pruning. Never mutates the input.
 */
export function reconcile(
  state: GameState,
  settings: Settings,
  species: SpeciesData,
  now: number,
): GameState {
  const gracePasses = pruneGracePasses(state.gracePasses, now);
  const today = localDateString(now);

  // No day rollover: only grace pruning changed.
  if (!(today > state.lastRegenDate)) {
    return { ...state, gracePasses };
  }

  // --- Day rollover ---
  const completedDay = state.lastRegenDate;
  const qualified = state.paidEntriesToday < settings.levelUpThreshold;

  // Work on copies of the party so we never mutate input members.
  let party: PartyMember[] = state.party.map((m) => ({ ...m }));
  let coins = state.coins;
  let incubator = state.incubator ? { ...state.incubator } : null;

  const guardianId = state.activeGuardianId;
  const guardianIdx = guardianId == null
    ? -1
    : party.findIndex((m) => m.id === guardianId);
  const hadGuardian = guardianIdx !== -1;

  // 1. Qualifying + guardian set → level the guardian, award coins, advance egg.
  if (qualified && hadGuardian) {
    const g = party[guardianIdx];
    const line = lineFor(species, g.species);

    const stageBefore = line ? stageIndexForLevel(line, g.level) : 0;
    g.level = g.level + 1;
    const stageAfter = line ? stageIndexForLevel(line, g.level) : 0;

    if (stageAfter > stageBefore && g.pendingEvolution == null) {
      g.pendingEvolution = { fromStage: stageBefore, toStage: stageAfter };
    }

    // Coins: round(baseReward × (threshold − paid) / threshold), paid<threshold.
    const t = settings.levelUpThreshold;
    coins += Math.round(
      (settings.baseReward * (t - state.paidEntriesToday)) / t,
    );

    // Egg incubation advances on a qualifying day; hatch at daysToHatch.
    if (incubator) {
      const progressDays = incubator.progressDays + 1;
      if (progressDays >= settings.daysToHatch) {
        const suffix = Math.random().toString(36).slice(2, 8);
        party.push({
          id: `mon_${now.toString(36)}${suffix}`,
          species: incubator.species,
          level: settings.starterLevel,
          hp: memberMaxHp(settings),
          faintStreak: 0,
          pendingEvolution: null,
        });
        incubator = null;
      } else {
        incubator = { ...incubator, progressDays };
      }
    }
  }
  // No guardian, or non-qualifying day → nothing (no level / coins / egg).

  // 2. faintStreak reset: guardian existed AND did not faint on the completed
  //    day (i.e. guarded a full day without fainting) → streak 0.
  if (hadGuardian && state.faintedTodayDate !== completedDay) {
    party[guardianIdx].faintStreak = 0;
  }

  // 3. Revive: a fainted (hp<=0) guardian comes back at full hp for its
  //    already-de-leveled level.
  if (hadGuardian && party[guardianIdx].hp <= 0) {
    party[guardianIdx].hp = memberMaxHp(settings);
  }

  // 4. Reset dailies. Guardian carries over.
  return {
    ...state,
    coins,
    party,
    incubator,
    paidEntriesToday: 0,
    guardianLockedToday: false,
    faintedTodayDate: null,
    lastRegenDate: today,
    gracePasses,
  };
}

// ---------------------------------------------------------------------------
// payEntry
// ---------------------------------------------------------------------------

export interface PayEntryResult {
  state: GameState;
  outcome: 'granted' | 'faint' | 'permadeath' | 'no-guardian';
  graceExpiresAt: number;
}

/**
 * Pay 1 entry against the active guardian. Assumes the caller already
 * reconciled and already decided the entry is permitted (does not itself reject
 * lockout). A grace pass is ALWAYS granted (the fatal blow is still honored).
 */
export function payEntry(
  state: GameState,
  settings: Settings,
  species: SpeciesData,
  domain: string,
  now: number,
): PayEntryResult {
  const graceExpiresAt = now + settings.graceMinutes * 60_000;
  const guardianIdx = state.activeGuardianId == null
    ? -1
    : state.party.findIndex((m) => m.id === state.activeGuardianId);

  if (guardianIdx === -1) {
    // Nothing guards you — no damage, no state change.
    return { state, outcome: 'no-guardian', graceExpiresAt };
  }

  const today = localDateString(now);
  const party: PartyMember[] = state.party.map((m) => ({ ...m }));
  const g = party[guardianIdx];

  g.hp = Math.max(0, g.hp - settings.damagePerEntry);

  const base: GameState = {
    ...state,
    party,
    guardianLockedToday: true,
    paidEntriesToday: state.paidEntriesToday + 1,
    gracePasses: { ...state.gracePasses, [domain]: graceExpiresAt },
  };

  if (g.hp > 0) {
    return { state: base, outcome: 'granted', graceExpiresAt };
  }

  // Guardian fainted this entry.
  g.faintStreak = g.faintStreak + 1;

  if (g.faintStreak >= settings.faintStreakToPermadeath) {
    // Permadeath: remove the mon; clear guardian.
    const removedId = g.id;
    const survivors = party.filter((m) => m.id !== removedId);
    const newState: GameState = {
      ...base,
      party: survivors,
      activeGuardianId: null,
      faintedTodayDate: today,
    };
    return { state: newState, outcome: 'permadeath', graceExpiresAt };
  }

  // Faint: de-level, floored at the CURRENT stage's minLevel (never devolves).
  const line = lineFor(species, g.species);
  let floor = 1;
  if (line) {
    const stageIdx = stageIndexForLevel(line, g.level);
    floor = stageMinLevel(line, stageIdx);
  }
  g.level = Math.max(g.level - settings.faintLevelPenalty, floor);

  const newState: GameState = {
    ...base,
    faintedTodayDate: today,
  };
  return { state: newState, outcome: 'faint', graceExpiresAt };
}

// ---------------------------------------------------------------------------
// Party / guardian / egg actions (pure)
// ---------------------------------------------------------------------------

export interface SetGuardianResult {
  state: GameState;
  error?: 'locked' | 'not-found';
}

export function setGuardian(
  state: GameState,
  monId: string,
  now: number,
): SetGuardianResult {
  if (state.guardianLockedToday || isInLockout(state, now)) {
    return { state, error: 'locked' };
  }
  if (!state.party.some((m) => m.id === monId)) {
    return { state, error: 'not-found' };
  }
  return { state: { ...state, activeGuardianId: monId } };
}

export interface PickStarterResult {
  state: GameState;
  error?: 'party-not-empty' | 'unknown-species';
}

export function pickStarter(
  state: GameState,
  settings: Settings,
  species: SpeciesData,
  speciesId: string,
  now: number,
): PickStarterResult {
  if (state.party.length !== 0) {
    return { state, error: 'party-not-empty' };
  }
  if (lineFor(species, speciesId) == null) {
    return { state, error: 'unknown-species' };
  }
  const suffix = Math.random().toString(36).slice(2, 8);
  const member: PartyMember = {
    id: `mon_${now.toString(36)}${suffix}`,
    species: speciesId,
    level: settings.starterLevel,
    hp: memberMaxHp(settings),
    faintStreak: 0,
    pendingEvolution: null,
  };
  return {
    state: { ...state, party: [member], activeGuardianId: member.id },
  };
}

export interface BuyEggResult {
  state: GameState;
  error?: 'insufficient-coins' | 'incubator-full' | 'unknown-species';
}

export function buyEgg(
  state: GameState,
  settings: Settings,
  species: SpeciesData,
  speciesId: string,
): BuyEggResult {
  if (lineFor(species, speciesId) == null) {
    return { state, error: 'unknown-species' };
  }
  if (state.incubator != null) {
    return { state, error: 'incubator-full' };
  }
  if (state.coins < settings.eggCost) {
    return { state, error: 'insufficient-coins' };
  }
  return {
    state: {
      ...state,
      coins: state.coins - settings.eggCost,
      incubator: { species: speciesId, progressDays: 0 },
    },
  };
}

export interface AckEvolutionResult {
  state: GameState;
  error?: 'no-pending-evolution' | 'not-found';
}

export function ackEvolution(state: GameState, monId: string): AckEvolutionResult {
  const idx = state.party.findIndex((m) => m.id === monId);
  if (idx === -1) {
    return { state, error: 'not-found' };
  }
  if (state.party[idx].pendingEvolution == null) {
    return { state, error: 'no-pending-evolution' };
  }
  const party = state.party.map((m) => ({ ...m }));
  party[idx].pendingEvolution = null;
  return { state: { ...state, party } };
}

// ---------------------------------------------------------------------------
// Settings-change clamp
// ---------------------------------------------------------------------------

/** Clamp every party member's hp into [0, maxHp]. Used after a settings change. */
export function clampPartyHp(state: GameState, settings: Settings): GameState {
  const max = memberMaxHp(settings);
  const party = state.party.map((m) => ({
    ...m,
    hp: Math.max(0, Math.min(m.hp, max)),
  }));
  return { ...state, party };
}

// ---------------------------------------------------------------------------
// Derived view
// ---------------------------------------------------------------------------

/** Coins the user would hold if the day ended right now (earn-curve preview). */
function coinsIfDayEndedNow(state: GameState, settings: Settings): number {
  const t = settings.levelUpThreshold;
  if (state.paidEntriesToday >= t) return state.coins;
  const earned = Math.round(
    (settings.baseReward * (t - state.paidEntriesToday)) / t,
  );
  return state.coins + earned;
}

/** Derive the read-only v1 view from persisted state + settings + species. */
export function deriveState(
  state: GameState,
  settings: Settings,
  species: SpeciesData,
  now: number,
): DerivedState {
  const guardian = findGuardian(state);
  const inLockout = isInLockout(state, now);

  let stage = 0;
  let nextEvolutionLevel: number | null = null;
  if (guardian) {
    const line = lineFor(species, guardian.species);
    if (line) {
      stage = stageIndexForLevel(line, guardian.level);
      nextEvolutionLevel = nextEvoLevel(line, guardian.level);
    }
  }

  const desperate =
    guardian != null && guardian.hp <= Math.ceil(settings.maxHp / 3);

  const needsStarterPick = state.party.length === 0;
  const needsGuardianPick =
    state.party.length > 0 && state.activeGuardianId == null;

  let mood: DerivedState['mood'];
  if (inLockout || (guardian != null && guardian.hp <= 0)) {
    mood = 'fainted';
  } else if (desperate) {
    mood = 'desperate';
  } else {
    mood = 'idle';
  }

  return {
    guardian,
    stage,
    desperate,
    inLockout,
    lockoutUntil: inLockout ? nextLocalMidnight(now) : null,
    needsStarterPick,
    needsGuardianPick,
    nextEvolutionLevel,
    coinsIfDayEndedNow: coinsIfDayEndedNow(state, settings),
    mood,
  };
}
