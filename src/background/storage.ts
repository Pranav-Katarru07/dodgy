// Storage module over chrome.storage.local. Serializes concurrent mutations
// with a promise-chain mutex, because an MV3 service worker can receive
// overlapping messages and must not interleave read-modify-write cycles.
import type { Settings, GameState } from '../shared/types';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../shared/constants';
import { freshState } from './state';
import { migrateStorage } from './migrate';

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const raw = got[STORAGE_KEYS.settings] as Settings | undefined;
  return raw ?? DEFAULT_SETTINGS;
}

export async function loadState(): Promise<GameState | null> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.state);
  const raw = got[STORAGE_KEYS.state] as GameState | undefined;
  return raw ?? null;
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: s });
}

export async function saveState(s: GameState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.state]: s });
}

// Module-level mutex: every mutate() chains onto this promise so read-modify-write
// cycles run strictly one at a time. Errors in one mutation must not break the
// chain, so we swallow rejections on the queue link itself.
let queue: Promise<unknown> = Promise.resolve();

/**
 * The ONLY place message handlers write state. Serialized read-modify-write:
 * loads current settings+state (initializing state via freshState if missing),
 * calls `fn`, persists whatever it returns, and resolves with `result`.
 */
export function mutate<T>(
  fn: (ctx: { settings: Settings; state: GameState }) => Promise<{
    settings?: Settings;
    state?: GameState;
    result: T;
  }>,
): Promise<T> {
  const run = queue.then(async () => {
    const settings = await loadSettings();
    let state = await loadState();
    if (state == null) {
      state = freshState(settings, Date.now());
      await saveState(state);
    }

    const out = await fn({ settings, state });

    if (out.settings !== undefined) {
      await saveSettings(out.settings);
    }
    if (out.state !== undefined) {
      await saveState(out.state);
    }
    return out.result;
  });

  // Keep the queue alive even if this mutation rejects.
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Ensure both storage keys exist. Runs the v0.4 → v1 migration first (idempotent),
 * then fills any still-missing key with defaults / freshState. Safe to call on
 * every install and startup.
 */
export async function ensureInitialized(): Promise<void> {
  await migrateStorage(Date.now());

  const got = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.state]);
  const settings = (got[STORAGE_KEYS.settings] as Settings | undefined) ?? DEFAULT_SETTINGS;
  if (got[STORAGE_KEYS.settings] === undefined) {
    await saveSettings(settings);
  }
  if (got[STORAGE_KEYS.state] === undefined) {
    await saveState(freshState(settings, Date.now()));
  }
}
