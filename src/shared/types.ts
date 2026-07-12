// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  // --- Core ---
  maxHp: number;
  damagePerEntry: number;
  /** How hard the guardian is to catch: integer 1 (gentle) .. 10 (legendary), default 5. */
  chaseDifficulty: number;
  levelUpThreshold: number;
  graceMinutes: number;
  blocklist: string[];

  // --- Pokémon v1 ---
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
}

// ---------------------------------------------------------------------------
// v1 persisted state
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
// DerivedState
// ---------------------------------------------------------------------------

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
// FullState
// ---------------------------------------------------------------------------

/** The v1 combined view sent to pages. */
export interface FullState {
  settings: Settings;
  state: GameState;
  derived: DerivedState;
}

// ---------------------------------------------------------------------------
// Sprite engine API
// ---------------------------------------------------------------------------

/** Base looping animation the sprite plays. */
export type BaseAnim = 'idle' | 'walk';

/** Transient overlay effect, or null for none. */
export type Effect = 'hurt' | 'desperate' | 'fainted' | 'happy' | null;

/**
 * The v1 sprite renderer contract, implemented by {@link
 * import('./sprite-engine').PokemonSprite} against a species'
 * {@link import('./species').SpeciesStage} sprite sheets.
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
