import type { Settings, PetState, DerivedState } from '../shared/types';

/**
 * Pure, side-effect-free state-transition functions.
 * NO chrome APIs, NO Date.now() inside these functions — every function that
 * needs the current time takes `now` (epoch ms) as an explicit parameter so
 * tests can mock time.
 */

/** Returns local-timezone YYYY-MM-DD for the given epoch ms. */
export function localDateString(now: number): string {
  const d = new Date(now);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Initial state on install. */
export function freshState(settings: Settings, now: number): PetState {
  return {
    hp: settings.maxHp,
    level: 0,
    paidEntriesToday: 0,
    lastRegenDate: localDateString(now),
    lockoutUntil: null,
    gracePasses: {},
  };
}

/** true iff lockoutUntil != null && lockoutUntil > now. */
export function isInLockout(state: PetState, now: number): boolean {
  return state.lockoutUntil != null && state.lockoutUntil > now;
}

/**
 * Idempotent reconciliation from timestamps. Returns a NEW state object
 * (never mutates the input).
 */
export function reconcile(state: PetState, settings: Settings, now: number): PetState {
  // Work on a shallow copy; gracePasses is rebuilt fresh below.
  let hp = state.hp;
  let level = state.level;
  let paidEntriesToday = state.paidEntriesToday;
  let lastRegenDate = state.lastRegenDate;
  let lockoutUntil = state.lockoutUntil;

  // a. Lockout expiry -> revive.
  if (lockoutUntil != null && lockoutUntil <= now) {
    level = 0;
    hp = settings.maxHp;
    lockoutUntil = null;
    paidEntriesToday = 0;
  }

  // b. Grace-pass expiry: drop passes with value <= now.
  const gracePasses: Record<string, number> = {};
  for (const [domain, expiry] of Object.entries(state.gracePasses)) {
    if (expiry > now) {
      gracePasses[domain] = expiry;
    }
  }

  // c. Day rollover.
  const today = localDateString(now);
  if (today > lastRegenDate) {
    const stillLocked = lockoutUntil != null && lockoutUntil > now;
    if (stillLocked) {
      // Pet is dead/resting: advance the date only.
      lastRegenDate = today;
    } else {
      // Multi-day gap counts as ONE qualifying block, not one each.
      if (paidEntriesToday < settings.levelUpThreshold) {
        level = level + 1;
      }
      hp = settings.maxHp;
      paidEntriesToday = 0;
      lastRegenDate = today;
    }
  }

  return {
    hp,
    level,
    paidEntriesToday,
    lastRegenDate,
    lockoutUntil,
    gracePasses,
  };
}

/**
 * Pay an entry. Assumes caller already reconciled and already checked the
 * entry is allowed. Does not itself reject lockout.
 */
export function payEntry(
  state: PetState,
  settings: Settings,
  domain: string,
  now: number,
): { state: PetState; outcome: 'granted' | 'death'; graceExpiresAt: number } {
  const newHp = Math.max(0, state.hp - settings.damagePerEntry);
  const paidEntriesToday = state.paidEntriesToday + 1;
  const graceExpiresAt = now + settings.graceMinutes * 60_000;

  if (newHp <= 0) {
    // DEATH: fatal hit honored. Clear all OTHER passes but keep a fresh pass
    // for the fatal domain.
    const newState: PetState = {
      hp: 0,
      level: 0,
      paidEntriesToday,
      lastRegenDate: state.lastRegenDate,
      lockoutUntil: now + settings.lockoutHours * 3_600_000,
      gracePasses: { [domain]: graceExpiresAt },
    };
    return { state: newState, outcome: 'death', graceExpiresAt };
  }

  const newState: PetState = {
    hp: newHp,
    level: state.level,
    paidEntriesToday,
    lastRegenDate: state.lastRegenDate,
    lockoutUntil: state.lockoutUntil,
    gracePasses: { ...state.gracePasses, [domain]: graceExpiresAt },
  };
  return { state: newState, outcome: 'granted', graceExpiresAt };
}

/** Clamp hp to [0, maxHp]. Used after settings change lowers maxHp. */
export function clampHpToSettings(state: PetState, settings: Settings): PetState {
  const hp = Math.max(0, Math.min(state.hp, settings.maxHp));
  return { ...state, hp };
}

/** Derive read-only view from persisted state. */
export function deriveState(state: PetState, settings: Settings, now: number): DerivedState {
  const evolutionTier = Math.floor(state.level / settings.levelsPerEvolution);
  const desperate = state.hp <= Math.ceil(settings.maxHp / 3);
  const inLockout = isInLockout(state, now);

  let mood: DerivedState['mood'];
  if (inLockout) {
    mood = 'dead';
  } else if (desperate) {
    mood = 'desperate';
  } else {
    mood = 'idle';
  }

  return { evolutionTier, desperate, inLockout, mood };
}
