import {
  localDateString,
  freshState,
  isInLockout,
  reconcile,
  payEntry,
  clampHpToSettings,
  deriveState,
} from './state';
import { DEFAULT_SETTINGS } from '../shared/constants';
import type { PetState, Settings } from '../shared/types';

const S: Settings = { ...DEFAULT_SETTINGS };
// DEFAULT_SETTINGS: maxHp 6, damagePerEntry 1, levelUpThreshold 3,
// levelsPerEvolution 30, graceMinutes 15, lockoutHours 24.

/** Local-midnight epoch ms for a local Y/M/D, so tests are timezone-agnostic. */
function localEpoch(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

function baseState(over: Partial<PetState> = {}): PetState {
  return {
    hp: 6,
    level: 0,
    paidEntriesToday: 0,
    lastRegenDate: '2026-07-08',
    lockoutUntil: null,
    gracePasses: {},
    ...over,
  };
}

describe('localDateString', () => {
  it('formats zero-padded local YYYY-MM-DD', () => {
    expect(localDateString(localEpoch(2026, 3, 5, 13, 30))).toBe('2026-03-05');
    expect(localDateString(localEpoch(2026, 12, 31, 23, 59))).toBe('2026-12-31');
  });

  it('reflects local calendar day (constructed from local components)', () => {
    const t = localEpoch(2026, 7, 8, 0, 1);
    expect(localDateString(t)).toBe('2026-07-08');
  });
});

describe('freshState', () => {
  it('initializes full HP, level 0, today as lastRegenDate', () => {
    const now = localEpoch(2026, 7, 8, 9, 0);
    const st = freshState(S, now);
    expect(st).toEqual({
      hp: S.maxHp,
      level: 0,
      paidEntriesToday: 0,
      lastRegenDate: '2026-07-08',
      lockoutUntil: null,
      gracePasses: {},
    });
  });
});

describe('isInLockout', () => {
  it('true only when lockoutUntil in the future', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    expect(isInLockout(baseState({ lockoutUntil: now + 1000 }), now)).toBe(true);
    expect(isInLockout(baseState({ lockoutUntil: now }), now)).toBe(false);
    expect(isInLockout(baseState({ lockoutUntil: now - 1 }), now)).toBe(false);
    expect(isInLockout(baseState({ lockoutUntil: null }), now)).toBe(false);
  });
});

describe('reconcile — day rollover', () => {
  it('qualifying day awards exactly +1 level, heals, resets count, updates date', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = baseState({
      hp: 2,
      level: 5,
      paidEntriesToday: 2, // < threshold 3 => qualified
      lastRegenDate: '2026-07-08',
    });
    const out = reconcile(st, S, now);
    expect(out.level).toBe(6);
    expect(out.hp).toBe(S.maxHp);
    expect(out.paidEntriesToday).toBe(0);
    expect(out.lastRegenDate).toBe('2026-07-09');
  });

  it('non-qualifying day awards 0 levels but still heals + resets count', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = baseState({
      hp: 1,
      level: 5,
      paidEntriesToday: 3, // >= threshold => not qualified
      lastRegenDate: '2026-07-08',
    });
    const out = reconcile(st, S, now);
    expect(out.level).toBe(5);
    expect(out.hp).toBe(S.maxHp);
    expect(out.paidEntriesToday).toBe(0);
    expect(out.lastRegenDate).toBe('2026-07-09');
  });

  it('MULTI-DAY GAP CAP: several days elapsed, qualifying => exactly +1 (not +N)', () => {
    const now = localEpoch(2026, 7, 15, 8, 0); // 7 days after
    const st = baseState({
      hp: 0,
      level: 10,
      paidEntriesToday: 1, // qualified
      lastRegenDate: '2026-07-08',
    });
    const out = reconcile(st, S, now);
    expect(out.level).toBe(11); // +1, NOT +7
    expect(out.hp).toBe(S.maxHp);
    expect(out.paidEntriesToday).toBe(0);
    expect(out.lastRegenDate).toBe('2026-07-15');
  });

  it('no rollover when today <= lastRegenDate (clock backwards guard)', () => {
    const now = localEpoch(2026, 7, 7, 8, 0);
    const st = baseState({ level: 5, paidEntriesToday: 1, lastRegenDate: '2026-07-08' });
    const out = reconcile(st, S, now);
    expect(out.level).toBe(5);
    expect(out.paidEntriesToday).toBe(1);
    expect(out.lastRegenDate).toBe('2026-07-08');
  });

  it('rollover during lockout: date advances but no heal/level/reset', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = baseState({
      hp: 0,
      level: 0,
      paidEntriesToday: 4,
      lastRegenDate: '2026-07-08',
      lockoutUntil: now + 3_600_000, // still locked after step a
    });
    const out = reconcile(st, S, now);
    expect(out.hp).toBe(0);
    expect(out.level).toBe(0);
    expect(out.paidEntriesToday).toBe(4);
    expect(out.lastRegenDate).toBe('2026-07-09');
    expect(out.lockoutUntil).toBe(now + 3_600_000);
  });
});

describe('reconcile — lockout expiry', () => {
  it('revives to level 0, full HP, lockoutUntil null, count 0', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = baseState({
      hp: 0,
      level: 7,
      paidEntriesToday: 5,
      lastRegenDate: '2026-07-08',
      lockoutUntil: now - 1000, // expired
    });
    const out = reconcile(st, S, now);
    expect(out.level).toBe(0);
    expect(out.hp).toBe(S.maxHp);
    expect(out.lockoutUntil).toBeNull();
    expect(out.paidEntriesToday).toBe(0);
  });

  it('lockout expiry then same-call rollover heals via revived (not locked) state', () => {
    const now = localEpoch(2026, 7, 10, 8, 0);
    const st = baseState({
      hp: 0,
      level: 3,
      paidEntriesToday: 9,
      lastRegenDate: '2026-07-08',
      lockoutUntil: now - 5000, // expired => revive first
    });
    const out = reconcile(st, S, now);
    // Revived (level 0, hp max, count 0); rollover then runs on non-locked state.
    // paidEntriesToday is 0 after revive => qualifies => +1.
    expect(out.lockoutUntil).toBeNull();
    expect(out.level).toBe(1);
    expect(out.hp).toBe(S.maxHp);
    expect(out.lastRegenDate).toBe('2026-07-10');
  });
});

describe('reconcile — idempotency', () => {
  it('reconcile twice equals once (rollover)', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = baseState({ hp: 1, level: 4, paidEntriesToday: 1, lastRegenDate: '2026-07-08' });
    const once = reconcile(st, S, now);
    const twice = reconcile(once, S, now);
    expect(twice).toEqual(once);
  });

  it('reconcile twice equals once (lockout expiry)', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = baseState({ hp: 0, level: 5, lockoutUntil: now - 1, lastRegenDate: '2026-07-08' });
    const once = reconcile(st, S, now);
    const twice = reconcile(once, S, now);
    expect(twice).toEqual(once);
  });
});

describe('reconcile — grace-pass expiry', () => {
  it('drops stale passes (<= now), keeps future ones', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = baseState({
      gracePasses: {
        'stale.com': now - 1,
        'exact.com': now, // <= now => dropped
        'future.com': now + 60_000,
      },
    });
    const out = reconcile(st, S, now);
    expect(out.gracePasses).toEqual({ 'future.com': now + 60_000 });
  });
});

describe('payEntry — granted', () => {
  it('decrements hp by damagePerEntry, sets grace pass, no lockout', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = baseState({ hp: 6, paidEntriesToday: 1 });
    const { state: out, outcome, graceExpiresAt } = payEntry(st, S, 'youtube.com', now);
    expect(outcome).toBe('granted');
    expect(out.hp).toBe(5);
    expect(out.paidEntriesToday).toBe(2);
    expect(out.lockoutUntil).toBeNull();
    expect(graceExpiresAt).toBe(now + S.graceMinutes * 60_000);
    expect(out.gracePasses['youtube.com']).toBe(graceExpiresAt);
  });

  it('keeps other existing grace passes', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = baseState({ hp: 4, gracePasses: { 'other.com': now + 999_999 } });
    const { state: out } = payEntry(st, S, 'reddit.com', now);
    expect(out.gracePasses['other.com']).toBe(now + 999_999);
    expect(out.gracePasses['reddit.com']).toBe(now + S.graceMinutes * 60_000);
  });
});

describe('payEntry — death / fatal-pass carve-out', () => {
  it('HP to 0 => death, level 0, lockout set, other passes cleared, fatal pass kept', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = baseState({
      hp: 1,
      level: 9,
      paidEntriesToday: 2,
      gracePasses: { 'other.com': now + 999_999 },
    });
    const { state: out, outcome, graceExpiresAt } = payEntry(st, S, 'tiktok.com', now);
    expect(outcome).toBe('death');
    expect(out.hp).toBe(0);
    expect(out.level).toBe(0);
    expect(out.paidEntriesToday).toBe(3);
    expect(out.lockoutUntil).toBe(now + S.lockoutHours * 3_600_000);
    expect(graceExpiresAt).toBe(now + S.graceMinutes * 60_000);
    // OTHER passes cleared, fatal domain's pass kept.
    expect(out.gracePasses).toEqual({ 'tiktok.com': graceExpiresAt });
  });
});

describe('clampHpToSettings', () => {
  it('clamps hp down when maxHp lowered', () => {
    const lowered: Settings = { ...S, maxHp: 3 };
    const out = clampHpToSettings(baseState({ hp: 6 }), lowered);
    expect(out.hp).toBe(3);
  });

  it('leaves hp unchanged when within range', () => {
    const out = clampHpToSettings(baseState({ hp: 2 }), S);
    expect(out.hp).toBe(2);
  });
});

describe('deriveState', () => {
  it('evolutionTier floors at boundary (per=30)', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    expect(deriveState(baseState({ level: 30 }), S, now).evolutionTier).toBe(1);
    expect(deriveState(baseState({ level: 29 }), S, now).evolutionTier).toBe(0);
    expect(deriveState(baseState({ level: 59 }), S, now).evolutionTier).toBe(1);
    expect(deriveState(baseState({ level: 60 }), S, now).evolutionTier).toBe(2);
  });

  it('desperate boundary: maxHp 6 => desperate at hp<=2, not at 3', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    expect(deriveState(baseState({ hp: 2 }), S, now).desperate).toBe(true);
    expect(deriveState(baseState({ hp: 3 }), S, now).desperate).toBe(false);
  });

  it('mood maps: lockout => dead, desperate => desperate, else idle', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    expect(deriveState(baseState({ hp: 0, lockoutUntil: now + 1000 }), S, now).mood).toBe('dead');
    expect(deriveState(baseState({ hp: 1 }), S, now).mood).toBe('desperate');
    expect(deriveState(baseState({ hp: 6 }), S, now).mood).toBe('idle');
  });
});

describe('purity', () => {
  it('reconcile does not mutate input', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = baseState({ hp: 1, level: 4, paidEntriesToday: 1, gracePasses: { 'a.com': 1 } });
    const snapshot = JSON.parse(JSON.stringify(st));
    reconcile(st, S, now);
    expect(st).toEqual(snapshot);
  });

  it('payEntry does not mutate input', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = baseState({ hp: 1, level: 9, gracePasses: { 'other.com': now + 999_999 } });
    const snapshot = JSON.parse(JSON.stringify(st));
    payEntry(st, S, 'tiktok.com', now);
    expect(st).toEqual(snapshot);
  });
});
