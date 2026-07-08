// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
//
// Compatibility strategy (Phase 1 of the Pokémon v1 fork):
// `Settings` is EXTENDED IN PLACE. The v1 fields are added as required (so v1
// consumers in phases 2–3 get exactly the frozen shape), and the two v0.4-only
// fields (`lockoutHours`, `levelsPerEvolution`) are kept as required
// `@deprecated` fields so existing v0.4 code (`deriveState`, `validateSettings`,
// `settings.ts`) keeps compiling and all default/spread literals stay valid.
// `DEFAULT_SETTINGS` supplies every field, so `{ ...DEFAULT_SETTINGS }` in tests
// and spreads over persisted settings continue to satisfy the type.

export interface Settings {
  // --- Shared v0.4 + v1 ---
  maxHp: number;
  damagePerEntry: number;
  levelUpThreshold: number;
  graceMinutes: number;
  blocklist: string[];

  // --- v1 (frozen) ---
  /** Level a freshly-picked starter / hatched mon begins at. */
  starterLevel: number;
  /** Levels subtracted from a guardian when it faints. */
  faintLevelPenalty: number;
  /** Consecutive faints before a guardian permadies. */
  faintStreakToPermadeath: number;
  /** Coins earned per day the guardian survives (day-end reward baseline). */
  baseReward: number;
  /** Coin price of one egg. */
  eggCost: number;
  /** Days an egg incubates before hatching. */
  daysToHatch: number;
  /** Title shown on the Pokédex screen. */
  pokedexTitle: string;

  // --- v0.4 (deprecated; retained for green-tree compatibility) ---
  /**
   * @deprecated v0.4 only. Lockout is now derived from `faintedTodayDate`
   * (next local midnight). Retained so v0.4 consumers keep compiling.
   */
  lockoutHours: number;
  /**
   * @deprecated v0.4 only. Evolution now comes from species stage `minLevel`.
   * Retained so v0.4 `deriveState`/`validateSettings` keep compiling.
   */
  levelsPerEvolution: number;
}

// ---------------------------------------------------------------------------
// v0.4 persisted/derived state (deprecated — retained for green-tree)
// ---------------------------------------------------------------------------

/**
 * @deprecated v0.4 persisted state. Superseded by {@link GameState}. Retained
 * because the v0.4 state machine, storage, and tests still import it. Phase 4
 * removes it.
 */
export interface PetState {
  hp: number;
  level: number;
  paidEntriesToday: number;
  /** YYYY-MM-DD, local date */
  lastRegenDate: string;
  /** epoch ms, or null when not locked out */
  lockoutUntil: number | null;
  /** domain -> grace-pass expiry epoch ms */
  gracePasses: Record<string, number>;
}

// ---------------------------------------------------------------------------
// v1 persisted state (frozen)
// ---------------------------------------------------------------------------

/** Opaque species identifier, e.g. `"charmander"`. */
export type SpeciesId = string;

/** One party member (a captured/owned Pokémon). */
export interface PartyMember {
  id: string;
  species: SpeciesId;
  level: number;
  hp: number;
  /** Consecutive faints; reset on a surviving day. */
  faintStreak: number;
  /** Set when a level-up crossed an evolution threshold and awaits ACK. */
  pendingEvolution: { fromStage: number; toStage: number } | null;
}

/** An egg being incubated. */
export interface Incubator {
  species: SpeciesId;
  progressDays: number;
}

/** The v1 persisted game state. */
export interface GameState {
  schemaVersion: 1;
  coins: number;
  party: PartyMember[];
  activeGuardianId: string | null;
  guardianLockedToday: boolean;
  /** YYYY-MM-DD (local) on which today's guardian fainted; null otherwise. */
  faintedTodayDate: string | null;
  incubator: Incubator | null;
  paidEntriesToday: number;
  /** YYYY-MM-DD, local date of the last HP regen / day reconcile. */
  lastRegenDate: string;
  /** domain -> grace-pass expiry epoch ms */
  gracePasses: Record<string, number>;
}

// ---------------------------------------------------------------------------
// DerivedState — collision-resolved
// ---------------------------------------------------------------------------
//
// The v0.4 `deriveState()` returns `{ evolutionTier, desperate, inLockout, mood }`.
// The v1 shape is entirely different and required under the SAME frozen name.
// A single interface cannot be both, so `DerivedState` is defined as the v1
// shape (frozen), and the v0.4 shape is preserved as the separate exported name
// `LegacyDerivedState`. The v0.4 `deriveState()` in `src/background/state.ts` is
// annotated to return `LegacyDerivedState` (the ONLY mechanical v0.4 edit made).

/**
 * @deprecated v0.4 derived view. Superseded by {@link DerivedState}. Retained
 * for the v0.4 state machine until phases 2–3 swap consumers.
 */
export interface LegacyDerivedState {
  evolutionTier: number;
  /** hp <= ceil(maxHp / 3) */
  desperate: boolean;
  inLockout: boolean;
  mood: 'idle' | 'happy' | 'hurt' | 'desperate' | 'dead';
}

/** The v1 read-only view derived from {@link GameState} + {@link Settings}. */
export interface DerivedState {
  /** The active guardian, or null when none is chosen/available. */
  guardian: PartyMember | null;
  /** Guardian's current evolution stage index (0-based). */
  stage: number;
  /** guardian.hp <= ceil(maxHp / 3) */
  desperate: boolean;
  /** faintedTodayDate === today (local). */
  inLockout: boolean;
  /** Next local-midnight epoch ms when inLockout, else null. DERIVED. */
  lockoutUntil: number | null;
  /** party is empty — the user must pick a starter. */
  needsStarterPick: boolean;
  /** party nonempty && activeGuardianId is null — the user must pick a guardian. */
  needsGuardianPick: boolean;
  /** minLevel of the guardian's next stage, or null at the final stage. */
  nextEvolutionLevel: number | null;
  /** Coins the user would hold if the day ended right now. */
  coinsIfDayEndedNow: number;
  mood: 'idle' | 'desperate' | 'fainted';
}

// ---------------------------------------------------------------------------
// FullState — collision-resolved
// ---------------------------------------------------------------------------
//
// v0.4 `FullState.state` is a `PetState`; v1 `FullState.state` is a `GameState`.
// These are incompatible, so `FullState` is defined as the v1 shape (frozen) and
// the v0.4 shape is preserved as `LegacyFullState`. The three v0.4 producer/
// consumer sites in `src/background/index.ts` are annotated to `LegacyFullState`
// (the only other mechanical v0.4 edits made).

/**
 * @deprecated v0.4 combined view. Superseded by {@link FullState}. Retained for
 * the v0.4 background/gate/popup/settings code.
 */
export interface LegacyFullState {
  settings: Settings;
  state: PetState;
  derived: LegacyDerivedState;
}

/** The v1 combined view sent to pages. */
export interface FullState {
  settings: Settings;
  state: GameState;
  derived: DerivedState;
}

// ---------------------------------------------------------------------------
// v0.4 sprite manifest (deprecated — retained for green-tree)
// ---------------------------------------------------------------------------

/**
 * @deprecated v0.4 sprite state. The v1 sprite engine uses {@link BaseAnim} +
 * {@link Effect}. Retained because `sprite-engine.ts` still imports it.
 */
export type SpriteState = 'idle' | 'run' | 'happy' | 'hurt' | 'desperate' | 'dead';

/**
 * @deprecated v0.4 sprite manifest entry. Superseded by the species-driven
 * {@link import('./species').SheetRef}. Retained for `sprite-engine.ts`.
 */
export interface SpriteManifestEntry {
  tier: number;
  state: SpriteState;
  sheetUrl: string;
  frameW: number;
  frameH: number;
  frames: number;
  fps: number;
}

// ---------------------------------------------------------------------------
// Sprite engine v2 API — TYPES ONLY (frozen for Phase 2B to implement against)
// ---------------------------------------------------------------------------

/** Base looping animation the sprite plays. */
export type BaseAnim = 'idle' | 'walk';

/** Transient overlay effect, or null for none. */
export type Effect = 'hurt' | 'desperate' | 'fainted' | 'happy' | null;

/**
 * The v1 sprite renderer contract. Phase 2B implements this against a species'
 * {@link import('./species').SpeciesStage} sprite sheets. Types only here — no
 * implementation lives in Phase 1.
 */
export interface PokemonSpriteApi {
  /** Load the sheets required to render this sprite; resolves when ready. */
  load(): Promise<void>;
  /** Set the base looping animation. */
  setAnim(anim: BaseAnim): void;
  /** Point the sprite along a movement vector (picks the PMD direction row). */
  setDirection(dx: number, dy: number): void;
  /** Apply (or clear, with null) a transient effect. */
  setEffect(effect: Effect): void;
  /** Position the sprite's center in canvas coordinates. */
  setPosition(x: number, y: number): void;
  /** Set the integer draw scale. */
  setScale(scale: number): void;
  /** Draw the current frame once. Never throws once loaded. */
  renderFrame(): void;
  /** Begin the render loop. Idempotent. */
  start(): void;
  /** Stop the render loop. Idempotent. */
  stop(): void;
}
