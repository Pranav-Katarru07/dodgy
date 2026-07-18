// v1 (Pokémon) pure state-machine tests. Fixture-driven (SPECIES_FIXTURE), all
// time injected via localEpoch() so the suite is timezone-agnostic. Covers the
// Phase 2A behavior spec: coin curve, guardian-only leveling, egg advance/hatch,
// faintStreak reset semantics, de-level floors, revive, permadeath, guardian
// day-lock lifecycle, pickStarter/buyEgg/ackEvolution guards, reconcile
// idempotency, grace-on-fatal-blow.
import {
  localDateString,
  nextLocalMidnight,
  freshState,
  isInLockout,
  reconcile,
  payEntry,
  setGuardian,
  pickStarter,
  buyEgg,
  ackEvolution,
  clampPartyHp,
  deriveState,
} from './state';
import { DEFAULT_SETTINGS } from '../shared/constants';
import { SPECIES_FIXTURE } from '../shared/species-fixture';
import type { GameState, PartyMember, Settings } from '../shared/types';

const S: Settings = { ...DEFAULT_SETTINGS };
// DEFAULT_SETTINGS (v1): maxHp 6, damagePerEntry 1, levelUpThreshold 3,
// graceMinutes 15, starterLevel 5, faintLevelPenalty 5, faintStreakToPermadeath
// 3, baseReward 10, eggCost 50, daysToHatch 5.
const SP = SPECIES_FIXTURE;

/** Local-midnight epoch ms for a local Y/M/D, so tests are timezone-agnostic. */
function localEpoch(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

function mon(over: Partial<PartyMember> = {}): PartyMember {
  return {
    id: 'mon_1',
    species: 'charmander',
    level: 5,
    hp: 6,
    faintStreak: 0,
    pendingEvolution: null,
    ...over,
  };
}

function baseState(over: Partial<GameState> = {}): GameState {
  return {
    schemaVersion: 1,
    coins: 0,
    party: [],
    activeGuardianId: null,
    guardianLockedToday: false,
    faintedTodayDate: null,
    incubator: null,
    paidEntriesToday: 0,
    lastRegenDate: '2026-07-08',
    gracePasses: {},
    ...over,
  };
}

/** A state with one charmander guardian at the given level/hp. */
function withGuardian(m: Partial<PartyMember> = {}, over: Partial<GameState> = {}): GameState {
  const g = mon(m);
  return baseState({ party: [g], activeGuardianId: g.id, ...over });
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

describe('localDateString / nextLocalMidnight', () => {
  it('formats zero-padded local YYYY-MM-DD', () => {
    expect(localDateString(localEpoch(2026, 3, 5, 13, 30))).toBe('2026-03-05');
    expect(localDateString(localEpoch(2026, 12, 31, 23, 59))).toBe('2026-12-31');
  });

  it('nextLocalMidnight is the following local 00:00', () => {
    const now = localEpoch(2026, 7, 8, 13, 30);
    expect(nextLocalMidnight(now)).toBe(localEpoch(2026, 7, 9, 0, 0));
  });
});

// ---------------------------------------------------------------------------
// freshState
// ---------------------------------------------------------------------------

describe('freshState', () => {
  it('empty party, no guardian, today as lastRegenDate', () => {
    const now = localEpoch(2026, 7, 8, 9, 0);
    expect(freshState(S, now)).toEqual({
      schemaVersion: 1,
      coins: 0,
      party: [],
      activeGuardianId: null,
      guardianLockedToday: false,
      faintedTodayDate: null,
      incubator: null,
      paidEntriesToday: 0,
      lastRegenDate: '2026-07-08',
      gracePasses: {},
    });
  });
});

// ---------------------------------------------------------------------------
// isInLockout
// ---------------------------------------------------------------------------

describe('isInLockout', () => {
  it('true iff faintedTodayDate === today (local)', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    expect(isInLockout(baseState({ faintedTodayDate: '2026-07-08' }), now)).toBe(true);
    expect(isInLockout(baseState({ faintedTodayDate: '2026-07-07' }), now)).toBe(false);
    expect(isInLockout(baseState({ faintedTodayDate: null }), now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcile — coin curve (10/7/3/0) + rounding
// ---------------------------------------------------------------------------

describe('reconcile — coin curve', () => {
  const cases: Array<[number, number]> = [
    [0, 10], // round(10 * 3/3) = 10
    [1, 7], //  round(10 * 2/3) = round(6.66) = 7
    [2, 3], //  round(10 * 1/3) = round(3.33) = 3
    [3, 0], //  not qualifying
    [4, 0], //  not qualifying
  ];
  for (const [paid, expected] of cases) {
    it(`paidEntries=${paid} earns ${expected} coins`, () => {
      const now = localEpoch(2026, 7, 9, 8, 0);
      const st = withGuardian({ level: 5 }, { paidEntriesToday: paid, coins: 100 });
      const out = reconcile(st, S, SP, now);
      expect(out.coins).toBe(100 + expected);
    });
  }

  it('no guardian earns nothing even on a clean day', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = baseState({ paidEntriesToday: 0, coins: 42 });
    const out = reconcile(st, S, SP, now);
    expect(out.coins).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// reconcile — guardian-only leveling
// ---------------------------------------------------------------------------

describe('reconcile — guardian-only leveling', () => {
  it('qualifying day: +1 to guardian only, benched untouched', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const guardian = mon({ id: 'g', level: 10 });
    const benched = mon({ id: 'b', level: 20 });
    const st = baseState({
      party: [guardian, benched],
      activeGuardianId: 'g',
      paidEntriesToday: 0,
    });
    const out = reconcile(st, S, SP, now);
    expect(out.party.find((m) => m.id === 'g')!.level).toBe(11);
    expect(out.party.find((m) => m.id === 'b')!.level).toBe(20);
  });

  it('non-qualifying day: no level, no coins', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian({ level: 10 }, { paidEntriesToday: 3, coins: 5 });
    const out = reconcile(st, S, SP, now);
    expect(out.party[0].level).toBe(10);
    expect(out.coins).toBe(5);
  });

  it('multi-day gap counts as ONE qualifying block (+1, not +N)', () => {
    const now = localEpoch(2026, 7, 15, 8, 0); // 7 days later
    const st = withGuardian({ level: 10 }, { paidEntriesToday: 1, lastRegenDate: '2026-07-08' });
    const out = reconcile(st, S, SP, now);
    expect(out.party[0].level).toBe(11);
    expect(out.lastRegenDate).toBe('2026-07-15');
  });

  it('no rollover when today <= lastRegenDate (clock-backwards guard)', () => {
    const now = localEpoch(2026, 7, 7, 8, 0);
    const st = withGuardian({ level: 10 }, { paidEntriesToday: 1, coins: 3 });
    const out = reconcile(st, S, SP, now);
    expect(out.party[0].level).toBe(10);
    expect(out.coins).toBe(3);
    expect(out.paidEntriesToday).toBe(1);
    expect(out.lastRegenDate).toBe('2026-07-08');
  });

  it('resets dailies and carries guardian over', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian(
      { level: 5 },
      { paidEntriesToday: 2, guardianLockedToday: true, faintedTodayDate: null },
    );
    const out = reconcile(st, S, SP, now);
    expect(out.paidEntriesToday).toBe(0);
    expect(out.guardianLockedToday).toBe(false);
    expect(out.faintedTodayDate).toBeNull();
    expect(out.activeGuardianId).toBe('mon_1');
  });
});

// ---------------------------------------------------------------------------
// reconcile — pendingEvolution on threshold cross
// ---------------------------------------------------------------------------

describe('reconcile — pendingEvolution', () => {
  it('15 -> 16 sets pendingEvolution {0,1}', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian({ level: 15 }, { paidEntriesToday: 0 });
    const out = reconcile(st, S, SP, now);
    expect(out.party[0].level).toBe(16);
    expect(out.party[0].pendingEvolution).toEqual({ fromStage: 0, toStage: 1 });
  });

  it('35 -> 36 sets pendingEvolution {1,2} (charmander -> charizard)', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian({ level: 35 }, { paidEntriesToday: 0 });
    const out = reconcile(st, S, SP, now);
    expect(out.party[0].level).toBe(36);
    expect(out.party[0].pendingEvolution).toEqual({ fromStage: 1, toStage: 2 });
  });

  it('31 -> 32 sets pendingEvolution for bulbasaur (venusaur @32)', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian({ species: 'bulbasaur', level: 31 }, { paidEntriesToday: 0 });
    const out = reconcile(st, S, SP, now);
    expect(out.party[0].level).toBe(32);
    expect(out.party[0].pendingEvolution).toEqual({ fromStage: 1, toStage: 2 });
  });

  it('non-crossing level-up leaves pendingEvolution null', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian({ level: 20 }, { paidEntriesToday: 0 });
    const out = reconcile(st, S, SP, now);
    expect(out.party[0].level).toBe(21);
    expect(out.party[0].pendingEvolution).toBeNull();
  });

  it('does not overwrite an existing pendingEvolution', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian(
      { level: 35, pendingEvolution: { fromStage: 0, toStage: 1 } },
      { paidEntriesToday: 0 },
    );
    const out = reconcile(st, S, SP, now);
    expect(out.party[0].pendingEvolution).toEqual({ fromStage: 0, toStage: 1 });
  });
});

// ---------------------------------------------------------------------------
// reconcile — egg incubation
// ---------------------------------------------------------------------------

describe('reconcile — egg incubation', () => {
  it('qualifying day advances egg by 1', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian(
      {},
      { paidEntriesToday: 0, incubator: { species: 'squirtle', progressDays: 2 } },
    );
    const out = reconcile(st, S, SP, now);
    expect(out.incubator).toEqual({ species: 'squirtle', progressDays: 3 });
  });

  it('non-qualifying day does NOT advance and does NOT reset egg', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian(
      {},
      { paidEntriesToday: 3, incubator: { species: 'squirtle', progressDays: 2 } },
    );
    const out = reconcile(st, S, SP, now);
    expect(out.incubator).toEqual({ species: 'squirtle', progressDays: 2 });
  });

  it('no guardian: egg does not advance (needs a qualifying guarded day)', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = baseState({
      paidEntriesToday: 0,
      incubator: { species: 'squirtle', progressDays: 2 },
    });
    const out = reconcile(st, S, SP, now);
    expect(out.incubator).toEqual({ species: 'squirtle', progressDays: 2 });
  });

  it('hatches at daysToHatch: new member Lv 5 full HP joins, incubator clears', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian(
      { id: 'g' },
      { paidEntriesToday: 0, incubator: { species: 'squirtle', progressDays: 4 } },
    );
    const out = reconcile(st, S, SP, now);
    expect(out.incubator).toBeNull();
    expect(out.party).toHaveLength(2);
    const hatched = out.party.find((m) => m.species === 'squirtle')!;
    expect(hatched.level).toBe(S.starterLevel);
    expect(hatched.hp).toBe(S.maxHp);
    expect(hatched.faintStreak).toBe(0);
    expect(hatched.pendingEvolution).toBeNull();
  });

  it('same rollover both levels guardian AND hatches the egg', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian(
      { id: 'g', level: 15 },
      { paidEntriesToday: 0, incubator: { species: 'bulbasaur', progressDays: 4 } },
    );
    const out = reconcile(st, S, SP, now);
    // Guardian leveled 15 -> 16 and got a pendingEvolution...
    const g = out.party.find((m) => m.id === 'g')!;
    expect(g.level).toBe(16);
    expect(g.pendingEvolution).toEqual({ fromStage: 0, toStage: 1 });
    // ...and the egg hatched in the same rollover.
    expect(out.incubator).toBeNull();
    expect(out.party.some((m) => m.species === 'bulbasaur')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reconcile — faintStreak reset semantics (both ways)
// ---------------------------------------------------------------------------

describe('reconcile — faintStreak reset', () => {
  it('resets to 0 when guardian did NOT faint on the completed day', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian(
      { faintStreak: 2 },
      { paidEntriesToday: 0, faintedTodayDate: null },
    );
    const out = reconcile(st, S, SP, now);
    expect(out.party[0].faintStreak).toBe(0);
  });

  it('does NOT reset when guardian fainted on the completed day', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    // Guardian fainted on 07-08 (the day being completed): streak stays.
    const st = withGuardian(
      { faintStreak: 2, hp: 0 },
      { paidEntriesToday: 6, faintedTodayDate: '2026-07-08' },
    );
    const out = reconcile(st, S, SP, now);
    expect(out.party[0].faintStreak).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// reconcile — revive a fainted guardian at its de-leveled level
// ---------------------------------------------------------------------------

describe('reconcile — revive', () => {
  it('fainted guardian revives to full HP, keeps de-leveled level', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian(
      { hp: 0, level: 16, faintStreak: 1 },
      { paidEntriesToday: 6, faintedTodayDate: '2026-07-08' },
    );
    const out = reconcile(st, S, SP, now);
    expect(out.party[0].hp).toBe(S.maxHp);
    expect(out.party[0].level).toBe(16); // unchanged by revive
    expect(out.faintedTodayDate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reconcile — idempotency
// ---------------------------------------------------------------------------

describe('reconcile — idempotency', () => {
  it('reconcile twice equals once (qualifying rollover + hatch)', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian(
      { level: 15 },
      { paidEntriesToday: 0, incubator: { species: 'squirtle', progressDays: 4 } },
    );
    const once = reconcile(st, S, SP, now);
    const twice = reconcile(once, S, SP, now);
    expect(twice).toEqual(once);
  });

  it('reconcile twice equals once (faint revive)', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian(
      { hp: 0, level: 16, faintStreak: 1 },
      { paidEntriesToday: 6, faintedTodayDate: '2026-07-08' },
    );
    const once = reconcile(st, S, SP, now);
    const twice = reconcile(once, S, SP, now);
    expect(twice).toEqual(once);
  });

  it('does not mutate input', () => {
    const now = localEpoch(2026, 7, 9, 8, 0);
    const st = withGuardian({ level: 15 }, { paidEntriesToday: 0 });
    const snapshot = JSON.parse(JSON.stringify(st));
    reconcile(st, S, SP, now);
    expect(st).toEqual(snapshot);
  });

  it('prunes stale grace passes even without a rollover', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = baseState({
      gracePasses: { 'stale.com': now - 1, 'exact.com': now, 'future.com': now + 60_000 },
    });
    const out = reconcile(st, S, SP, now);
    expect(out.gracePasses).toEqual({ 'future.com': now + 60_000 });
  });
});

// ---------------------------------------------------------------------------
// payEntry — granted / no-guardian
// ---------------------------------------------------------------------------

describe('payEntry — granted', () => {
  it('decrements hp, locks guardian for the day, sets grace pass', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ hp: 6 }, { paidEntriesToday: 1 });
    const { state: out, outcome, graceExpiresAt } = payEntry(st, S, SP, 'youtube.com', now);
    expect(outcome).toBe('granted');
    expect(out.party[0].hp).toBe(5);
    expect(out.paidEntriesToday).toBe(2);
    expect(out.guardianLockedToday).toBe(true);
    expect(graceExpiresAt).toBe(now + S.graceMinutes * 60_000);
    expect(out.gracePasses['youtube.com']).toBe(graceExpiresAt);
  });

  it('keeps other existing grace passes', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ hp: 4 }, { gracePasses: { 'other.com': now + 999_999 } });
    const { state: out } = payEntry(st, S, SP, 'reddit.com', now);
    expect(out.gracePasses['other.com']).toBe(now + 999_999);
    expect(out.gracePasses['reddit.com']).toBe(now + S.graceMinutes * 60_000);
  });

  it('no guardian: no-op, no damage, entry let through', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = baseState({ paidEntriesToday: 1 });
    const { state: out, outcome } = payEntry(st, S, SP, 'youtube.com', now);
    expect(outcome).toBe('no-guardian');
    expect(out).toEqual(st); // unchanged
  });

  it('does not mutate input', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ hp: 1, level: 20 }, { gracePasses: { 'a.com': now + 1 } });
    const snapshot = JSON.parse(JSON.stringify(st));
    payEntry(st, S, SP, 'tiktok.com', now);
    expect(st).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// payEntry — faint, de-level floors, grace-on-fatal-blow
// ---------------------------------------------------------------------------

describe('payEntry — faint & de-level floors', () => {
  it('grace pass is granted even on the fatal blow; other passes kept', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian(
      { hp: 1, level: 20 },
      { gracePasses: { 'other.com': now + 999_999 } },
    );
    const { state: out, outcome, graceExpiresAt } = payEntry(st, S, SP, 'tiktok.com', now);
    expect(outcome).toBe('faint');
    expect(out.party[0].hp).toBe(0);
    expect(graceExpiresAt).toBe(now + S.graceMinutes * 60_000);
    expect(out.gracePasses['tiktok.com']).toBe(graceExpiresAt);
    expect(out.gracePasses['other.com']).toBe(now + 999_999);
    expect(out.faintedTodayDate).toBe('2026-07-08');
  });

  it('faintStreak increments on faint', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ hp: 1, level: 20, faintStreak: 1 });
    const { state: out } = payEntry(st, S, SP, 'tiktok.com', now);
    expect(out.party[0].faintStreak).toBe(2);
  });

  it('Charizard (level 37) floors at stage min 36', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ hp: 1, level: 37 });
    const { state: out } = payEntry(st, S, SP, 'x.com', now);
    expect(out.party[0].level).toBe(36); // 37-5=32 floored up to 36
  });

  it('Charmeleon (level 17) floors at stage min 16', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ hp: 1, level: 17 });
    const { state: out } = payEntry(st, S, SP, 'x.com', now);
    expect(out.party[0].level).toBe(16); // 17-5=12 floored up to 16
  });

  it('Charmeleon (level 30) de-levels to 25 (no floor hit)', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ hp: 1, level: 30 });
    const { state: out } = payEntry(st, S, SP, 'x.com', now);
    expect(out.party[0].level).toBe(25); // 30-5, above floor 16
  });

  it('Charmander (level 3) floors at 1 (never below 1)', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ hp: 1, level: 3 });
    const { state: out } = payEntry(st, S, SP, 'x.com', now);
    expect(out.party[0].level).toBe(1); // 3-5=-2 floored to 1
  });

  it('never devolves: Charmeleon at 16 stays 16 after faint', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ hp: 1, level: 16 });
    const { state: out } = payEntry(st, S, SP, 'x.com', now);
    expect(out.party[0].level).toBe(16);
    // still stage 1 (Charmeleon), did not drop to Charmander
  });
});

// ---------------------------------------------------------------------------
// payEntry — permadeath at streak 3
// ---------------------------------------------------------------------------

describe('payEntry — permadeath', () => {
  it('3rd consecutive faint removes the mon and clears guardian', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ hp: 1, level: 20, faintStreak: 2 });
    const { state: out, outcome } = payEntry(st, S, SP, 'tiktok.com', now);
    expect(outcome).toBe('permadeath');
    expect(out.party).toHaveLength(0);
    expect(out.activeGuardianId).toBeNull();
    expect(out.faintedTodayDate).toBe('2026-07-08');
  });

  it('permadeath with other party members leaves survivors, clears guardian', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const guardian = mon({ id: 'g', hp: 1, level: 20, faintStreak: 2 });
    const other = mon({ id: 'o', species: 'squirtle', level: 10 });
    const st = baseState({ party: [guardian, other], activeGuardianId: 'g' });
    const { state: out, outcome } = payEntry(st, S, SP, 'tiktok.com', now);
    expect(outcome).toBe('permadeath');
    expect(out.party.map((m) => m.id)).toEqual(['o']);
    expect(out.activeGuardianId).toBeNull();
  });

  it('grace pass still granted on the permadeath blow', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ hp: 1, faintStreak: 2 });
    const { state: out, graceExpiresAt } = payEntry(st, S, SP, 'tiktok.com', now);
    expect(out.gracePasses['tiktok.com']).toBe(graceExpiresAt);
  });
});

// ---------------------------------------------------------------------------
// setGuardian — day-lock lifecycle
// ---------------------------------------------------------------------------

describe('setGuardian — day-lock', () => {
  it('switch allowed before first click-through', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const a = mon({ id: 'a' });
    const b = mon({ id: 'b', species: 'squirtle' });
    const st = baseState({ party: [a, b], activeGuardianId: 'a' });
    const { state: out, error } = setGuardian(st, 'b', now);
    expect(error).toBeUndefined();
    expect(out.activeGuardianId).toBe('b');
  });

  it('rejected after first paid entry (guardianLockedToday)', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const a = mon({ id: 'a' });
    const b = mon({ id: 'b', species: 'squirtle' });
    const st = baseState({ party: [a, b], activeGuardianId: 'a', guardianLockedToday: true });
    const { state: out, error } = setGuardian(st, 'b', now);
    expect(error).toBe('locked');
    expect(out.activeGuardianId).toBe('a');
  });

  it('rejected during lockout', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const a = mon({ id: 'a' });
    const b = mon({ id: 'b', species: 'squirtle' });
    const st = baseState({
      party: [a, b],
      activeGuardianId: 'a',
      faintedTodayDate: '2026-07-08',
    });
    const { error } = setGuardian(st, 'b', now);
    expect(error).toBe('locked');
  });

  it('rejected for an unknown member id', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ id: 'a' });
    const { error } = setGuardian(st, 'nope', now);
    expect(error).toBe('not-found');
  });
});

// ---------------------------------------------------------------------------
// pickStarter — empty-party-only + duplicates + unknown species
// ---------------------------------------------------------------------------

describe('pickStarter', () => {
  it('picks a starter into an empty party and sets it as guardian', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = baseState();
    const { state: out, error } = pickStarter(st, S, SP, 'charmander', now);
    expect(error).toBeUndefined();
    expect(out.party).toHaveLength(1);
    expect(out.party[0].species).toBe('charmander');
    expect(out.party[0].level).toBe(S.starterLevel);
    expect(out.party[0].hp).toBe(S.maxHp);
    expect(out.activeGuardianId).toBe(out.party[0].id);
  });

  it('rejected when party is not empty', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian();
    const { error } = pickStarter(st, S, SP, 'squirtle', now);
    expect(error).toBe('party-not-empty');
  });

  it('rejected for an unknown species', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = baseState();
    const { error } = pickStarter(st, S, SP, 'pikachu', now);
    expect(error).toBe('unknown-species');
  });
});

// ---------------------------------------------------------------------------
// buyEgg — coins + empty incubator + duplicates + unknown species
// ---------------------------------------------------------------------------

describe('buyEgg', () => {
  it('buys an egg: spends coins, fills incubator (duplicates allowed)', () => {
    const st = baseState({ coins: 50, party: [mon({ species: 'charmander' })] });
    const { state: out, error } = buyEgg(st, S, SP, 'charmander');
    expect(error).toBeUndefined();
    expect(out.coins).toBe(0);
    expect(out.incubator).toEqual({ species: 'charmander', progressDays: 0 });
  });

  it('rejected with insufficient coins', () => {
    const st = baseState({ coins: 49 });
    const { error } = buyEgg(st, S, SP, 'squirtle');
    expect(error).toBe('insufficient-coins');
  });

  it('rejected when incubator already full', () => {
    const st = baseState({ coins: 200, incubator: { species: 'squirtle', progressDays: 1 } });
    const { error } = buyEgg(st, S, SP, 'bulbasaur');
    expect(error).toBe('incubator-full');
  });

  it('rejected for an unknown species', () => {
    const st = baseState({ coins: 200 });
    const { error } = buyEgg(st, S, SP, 'mewtwo');
    expect(error).toBe('unknown-species');
  });
});

// ---------------------------------------------------------------------------
// ackEvolution
// ---------------------------------------------------------------------------

describe('ackEvolution', () => {
  it('clears a pending evolution', () => {
    const st = withGuardian({ id: 'g', pendingEvolution: { fromStage: 0, toStage: 1 } });
    const { state: out, error } = ackEvolution(st, 'g');
    expect(error).toBeUndefined();
    expect(out.party[0].pendingEvolution).toBeNull();
  });

  it('rejected when there is no pending evolution', () => {
    const st = withGuardian({ id: 'g', pendingEvolution: null });
    const { error } = ackEvolution(st, 'g');
    expect(error).toBe('no-pending-evolution');
  });

  it('rejected for an unknown member id', () => {
    const st = withGuardian({ id: 'g', pendingEvolution: { fromStage: 0, toStage: 1 } });
    const { error } = ackEvolution(st, 'nope');
    expect(error).toBe('not-found');
  });
});

// ---------------------------------------------------------------------------
// clampPartyHp
// ---------------------------------------------------------------------------

describe('clampPartyHp', () => {
  it('clamps every member into [0, maxHp]', () => {
    const lowered: Settings = { ...S, maxHp: 3 };
    const st = baseState({ party: [mon({ id: 'a', hp: 6 }), mon({ id: 'b', hp: 2 })] });
    const out = clampPartyHp(st, lowered);
    expect(out.party[0].hp).toBe(3);
    expect(out.party[1].hp).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// deriveState
// ---------------------------------------------------------------------------

describe('deriveState', () => {
  it('stage/nextEvolutionLevel track the guardian level', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ level: 20 });
    const d = deriveState(st, S, SP, now);
    expect(d.stage).toBe(1); // Charmeleon
    expect(d.nextEvolutionLevel).toBe(36); // Charizard
  });

  it('final stage has null nextEvolutionLevel', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const st = withGuardian({ level: 40 });
    const d = deriveState(st, S, SP, now);
    expect(d.stage).toBe(2);
    expect(d.nextEvolutionLevel).toBeNull();
  });

  it('desperate boundary: maxHp 6 => desperate at hp<=2, not at 3', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    expect(deriveState(withGuardian({ hp: 2 }), S, SP, now).desperate).toBe(true);
    expect(deriveState(withGuardian({ hp: 3 }), S, SP, now).desperate).toBe(false);
  });

  it('mood: lockout/fainted => fainted, low hp => desperate, else idle', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    expect(
      deriveState(withGuardian({ hp: 6 }, { faintedTodayDate: '2026-07-08' }), S, SP, now).mood,
    ).toBe('fainted');
    expect(deriveState(withGuardian({ hp: 1 }), S, SP, now).mood).toBe('desperate');
    expect(deriveState(withGuardian({ hp: 6 }), S, SP, now).mood).toBe('idle');
  });

  it('lockoutUntil is next local midnight when in lockout, else null', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    const locked = deriveState(withGuardian({}, { faintedTodayDate: '2026-07-08' }), S, SP, now);
    expect(locked.inLockout).toBe(true);
    expect(locked.lockoutUntil).toBe(localEpoch(2026, 7, 9, 0, 0));
    const free = deriveState(withGuardian(), S, SP, now);
    expect(free.inLockout).toBe(false);
    expect(free.lockoutUntil).toBeNull();
  });

  it('needsStarterPick when party empty; needsGuardianPick when party set but no guardian', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    expect(deriveState(baseState(), S, SP, now).needsStarterPick).toBe(true);
    const noGuardian = baseState({ party: [mon({ id: 'a' })], activeGuardianId: null });
    const d = deriveState(noGuardian, S, SP, now);
    expect(d.needsStarterPick).toBe(false);
    expect(d.needsGuardianPick).toBe(true);
  });

  it('coinsIfDayEndedNow previews the earn curve', () => {
    const now = localEpoch(2026, 7, 8, 12, 0);
    expect(deriveState(withGuardian({}, { coins: 100, paidEntriesToday: 1 }), S, SP, now)
      .coinsIfDayEndedNow).toBe(107);
    expect(deriveState(withGuardian({}, { coins: 100, paidEntriesToday: 3 }), S, SP, now)
      .coinsIfDayEndedNow).toBe(100);
  });
});
