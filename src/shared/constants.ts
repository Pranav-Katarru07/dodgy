import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  // Shared v0.4 + v1
  maxHp: 6,
  damagePerEntry: 1,
  levelUpThreshold: 3,
  graceMinutes: 15,
  blocklist: [
    'youtube.com',
    'twitter.com',
    'x.com',
    'instagram.com',
    'tiktok.com',
    'reddit.com',
    'facebook.com',
    'twitch.tv',
    'netflix.com',
    'hulu.com',
    '9gag.com',
    'pinterest.com',
    'tumblr.com',
  ],

  // Pokémon v1
  starterLevel: 5,
  faintLevelPenalty: 5,
  faintStreakToPermadeath: 3,
  baseReward: 10,
  eggCost: 50,
  daysToHatch: 5,
  pokedexTitle: 'Dodgédex',
};

export const STORAGE_KEYS = {
  settings: 'settings',
  state: 'state',
} as const;

export const ALARMS = {
  dailyRollover: 'daily-rollover',
  /** Per-domain grace-expiry alarms are named `${gracePrefix}${domain}`. */
  gracePrefix: 'grace:',
} as const;

// ---------------------------------------------------------------------------
// v1 constants (frozen)
// ---------------------------------------------------------------------------

/** Packaged path of the species table JSON, relative to the extension root. */
export const SPECIES_JSON_PATH = 'assets/pokemon/species.json';

/**
 * Row order of an 8-direction PokémonMysteryDungeon sprite sheet, top-to-bottom.
 * Index into this with the direction chosen from a movement vector.
 */
export const PMD_DIRECTION_ROWS = [
  'down',
  'down-right',
  'right',
  'up-right',
  'up',
  'up-left',
  'left',
  'down-left',
] as const;

/** Pixel font used across the v1 UI. */
export const PIXEL_FONT_FAMILY = 'Press Start 2P';
