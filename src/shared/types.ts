export interface Settings {
  maxHp: number;
  damagePerEntry: number;
  levelUpThreshold: number;
  levelsPerEvolution: number;
  graceMinutes: number;
  lockoutHours: number;
  blocklist: string[];
}

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

export interface DerivedState {
  evolutionTier: number;
  /** hp <= ceil(maxHp / 3) */
  desperate: boolean;
  inLockout: boolean;
  mood: 'idle' | 'happy' | 'hurt' | 'desperate' | 'dead';
}

export interface FullState {
  settings: Settings;
  state: PetState;
  derived: DerivedState;
}

export type SpriteState = 'idle' | 'run' | 'happy' | 'hurt' | 'desperate' | 'dead';

export interface SpriteManifestEntry {
  tier: number;
  state: SpriteState;
  sheetUrl: string;
  frameW: number;
  frameH: number;
  frames: number;
  fps: number;
}
