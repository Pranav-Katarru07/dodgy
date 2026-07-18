// v0.4 → v1 storage migration. Pure mapping helpers (`migrateSettings`,
// `migrateState`) are unit-tested; `migrateStorage()` is the chrome.storage
// wrapper that reads, migrates, and writes back. Idempotent: a v1 state (has
// `schemaVersion`) is left untouched.
import type { Settings, GameState } from '../shared/types';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../shared/constants';
import { freshState } from './state';

/** A stored v0.4 state has a top-level `hp` field and no `schemaVersion`. */
function isV1State(raw: unknown): raw is GameState {
  return (
    typeof raw === 'object' &&
    raw != null &&
    (raw as { schemaVersion?: unknown }).schemaVersion === 1
  );
}

/**
 * Carry the v0.4 settings that survive into v1 over DEFAULT_SETTINGS. Any
 * v0.4-only fields present in the old blob (e.g. `lockoutHours`,
 * `levelsPerEvolution`) are simply not copied, so they drop away; the v1 fields
 * come from DEFAULT_SETTINGS.
 */
export function migrateSettings(rawSettings: Partial<Settings> | undefined): Settings {
  const src = rawSettings ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...(src.maxHp !== undefined ? { maxHp: src.maxHp } : {}),
    ...(src.damagePerEntry !== undefined ? { damagePerEntry: src.damagePerEntry } : {}),
    ...(src.levelUpThreshold !== undefined ? { levelUpThreshold: src.levelUpThreshold } : {}),
    ...(src.graceMinutes !== undefined ? { graceMinutes: src.graceMinutes } : {}),
    ...(Array.isArray(src.blocklist) ? { blocklist: [...src.blocklist] } : {}),
  };
}

export interface MigrationResult {
  settings: Settings;
  state: GameState;
  /** True when a v0.4 → v1 migration was actually performed. */
  migrated: boolean;
}

/**
 * Pure mapping from raw stored blobs to a v1 settings+state pair.
 * - If `rawState` is already a v1 state, it is returned untouched (idempotent);
 *   settings are still normalized over DEFAULT_SETTINGS so a partial blob fills.
 * - Otherwise (v0.4 or absent), settings carry the surviving v0.4 fields and
 *   state is a fresh v1 GameState (empty party → first-run starter pick).
 */
export function migrateBlobs(
  rawSettings: Partial<Settings> | undefined,
  rawState: unknown,
  now: number,
): MigrationResult {
  if (isV1State(rawState)) {
    const settings: Settings = { ...DEFAULT_SETTINGS, ...(rawSettings ?? {}) };
    return { settings, state: rawState, migrated: false };
  }
  const settings = migrateSettings(rawSettings);
  return { settings, state: freshState(settings, now), migrated: true };
}

/**
 * Read storage, migrate v0.4 → v1 if needed, and write the result back.
 * Idempotent and safe to run on every startup before any other access.
 */
export async function migrateStorage(now: number = Date.now()): Promise<void> {
  const got = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.state]);
  const rawSettings = got[STORAGE_KEYS.settings] as Partial<Settings> | undefined;
  const rawState = got[STORAGE_KEYS.state];

  // Nothing stored at all: leave it for ensureInitialized/freshState.
  if (rawSettings === undefined && rawState === undefined) return;

  const { settings, state, migrated } = migrateBlobs(rawSettings, rawState, now);
  if (!migrated) return;

  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: settings,
    [STORAGE_KEYS.state]: state,
  });
}
