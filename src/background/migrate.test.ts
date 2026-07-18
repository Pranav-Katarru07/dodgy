// v0.4 -> v1 migration tests for the pure mapping helpers. `migrateStorage`
// (the chrome.storage wrapper) is not exercised here — only the deterministic
// `migrateSettings` / `migrateBlobs` mappings.
import { migrateSettings, migrateBlobs } from './migrate';
import { DEFAULT_SETTINGS } from '../shared/constants';
import type { Settings } from '../shared/types';

function localEpoch(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

// A representative v0.4 settings blob: has the surviving fields plus the two
// v0.4-only fields that must be dropped/reset.
const V04_SETTINGS = {
  maxHp: 8,
  damagePerEntry: 2,
  levelUpThreshold: 4,
  graceMinutes: 30,
  blocklist: ['youtube.com', 'reddit.com'],
  lockoutHours: 12,
  levelsPerEvolution: 25,
} as unknown as Partial<Settings>;

// A representative v0.4 state blob (single-pet shape, no schemaVersion).
const V04_STATE = {
  hp: 3,
  level: 12,
  paidEntriesToday: 1,
  lastRegenDate: '2026-07-01',
  lockoutUntil: null,
  gracePasses: { 'youtube.com': 999 },
};

describe('migrateSettings', () => {
  it('carries surviving v0.4 fields, resets dropped fields to v1 defaults', () => {
    const out = migrateSettings(V04_SETTINGS);
    // Carried through:
    expect(out.maxHp).toBe(8);
    expect(out.damagePerEntry).toBe(2);
    expect(out.levelUpThreshold).toBe(4);
    expect(out.graceMinutes).toBe(30);
    expect(out.blocklist).toEqual(['youtube.com', 'reddit.com']);
    // v0.4-only fields are dropped entirely (no longer part of Settings):
    expect((out as unknown as Record<string, unknown>).lockoutHours).toBeUndefined();
    expect((out as unknown as Record<string, unknown>).levelsPerEvolution).toBeUndefined();
    // New v1 fields come from defaults:
    expect(out.starterLevel).toBe(DEFAULT_SETTINGS.starterLevel);
    expect(out.faintLevelPenalty).toBe(DEFAULT_SETTINGS.faintLevelPenalty);
    expect(out.faintStreakToPermadeath).toBe(DEFAULT_SETTINGS.faintStreakToPermadeath);
    expect(out.baseReward).toBe(DEFAULT_SETTINGS.baseReward);
    expect(out.eggCost).toBe(DEFAULT_SETTINGS.eggCost);
    expect(out.daysToHatch).toBe(DEFAULT_SETTINGS.daysToHatch);
    expect(out.pokedexTitle).toBe(DEFAULT_SETTINGS.pokedexTitle);
  });

  it('deep-copies the blocklist (no aliasing of the source array)', () => {
    const out = migrateSettings(V04_SETTINGS);
    expect(out.blocklist).not.toBe(V04_SETTINGS.blocklist);
  });

  it('undefined input yields pure defaults', () => {
    expect(migrateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('partial blob fills missing fields from defaults', () => {
    const out = migrateSettings({ maxHp: 10 } as Partial<Settings>);
    expect(out.maxHp).toBe(10);
    expect(out.damagePerEntry).toBe(DEFAULT_SETTINGS.damagePerEntry);
    expect(out.blocklist).toEqual(DEFAULT_SETTINGS.blocklist);
  });
});

describe('migrateBlobs — v0.4 -> v1', () => {
  it('produces carried settings + a fresh empty-party GameState', () => {
    const now = localEpoch(2026, 7, 8, 9, 0);
    const { settings, state, migrated } = migrateBlobs(V04_SETTINGS, V04_STATE, now);
    expect(migrated).toBe(true);
    // Settings carried:
    expect(settings.maxHp).toBe(8);
    expect(settings.blocklist).toEqual(['youtube.com', 'reddit.com']);
    // Fresh v1 GameState — nothing from the v0.4 pet carried over:
    expect(state.schemaVersion).toBe(1);
    expect(state.coins).toBe(0);
    expect(state.party).toEqual([]);
    expect(state.activeGuardianId).toBeNull();
    expect(state.incubator).toBeNull();
    expect(state.faintedTodayDate).toBeNull();
    expect(state.paidEntriesToday).toBe(0);
    expect(state.gracePasses).toEqual({});
    expect(state.lastRegenDate).toBe('2026-07-08');
    // v0.4 pet fields must not leak in.
    const asRecord = state as unknown as Record<string, unknown>;
    expect(asRecord.hp).toBeUndefined();
    expect(asRecord.level).toBeUndefined();
    expect(asRecord.lockoutUntil).toBeUndefined();
  });

  it('absent state (first ever run) also migrates to a fresh GameState', () => {
    const now = localEpoch(2026, 7, 8, 9, 0);
    const { state, migrated } = migrateBlobs(undefined, undefined, now);
    expect(migrated).toBe(true);
    expect(state.schemaVersion).toBe(1);
    expect(state.party).toEqual([]);
  });
});

describe('migrateBlobs — idempotent on v1 state', () => {
  const V1_STATE = {
    schemaVersion: 1 as const,
    coins: 120,
    party: [
      { id: 'mon_1', species: 'charmander', level: 18, hp: 6, faintStreak: 0, pendingEvolution: null },
    ],
    activeGuardianId: 'mon_1',
    guardianLockedToday: true,
    faintedTodayDate: null,
    incubator: { species: 'squirtle', progressDays: 2 },
    paidEntriesToday: 1,
    lastRegenDate: '2026-07-08',
    gracePasses: {},
  };

  it('leaves a v1 state untouched and reports migrated=false', () => {
    const now = localEpoch(2026, 7, 9, 9, 0);
    const { state, migrated } = migrateBlobs({ ...DEFAULT_SETTINGS }, V1_STATE, now);
    expect(migrated).toBe(false);
    expect(state).toBe(V1_STATE); // same reference, unchanged
  });

  it('normalizes partial v1 settings over defaults while keeping the state', () => {
    const now = localEpoch(2026, 7, 9, 9, 0);
    const { settings, state, migrated } = migrateBlobs({ maxHp: 9 } as Partial<Settings>, V1_STATE, now);
    expect(migrated).toBe(false);
    expect(settings.maxHp).toBe(9);
    expect(settings.pokedexTitle).toBe(DEFAULT_SETTINGS.pokedexTitle);
    expect(state).toBe(V1_STATE);
  });

  it('running migrateBlobs on its own v1 output is a no-op (idempotent)', () => {
    const now = localEpoch(2026, 7, 8, 9, 0);
    const first = migrateBlobs(V04_SETTINGS, V04_STATE, now);
    const second = migrateBlobs(first.settings, first.state, now);
    expect(second.migrated).toBe(false);
    expect(second.state).toBe(first.state);
    expect(second.settings).toEqual(first.settings);
  });
});
