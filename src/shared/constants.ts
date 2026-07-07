import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  maxHp: 6,
  damagePerEntry: 1,
  levelUpThreshold: 3,
  levelsPerEvolution: 30,
  graceMinutes: 15,
  lockoutHours: 24,
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
};

export const STORAGE_KEYS = {
  settings: 'settings',
  state: 'state',
} as const;

export const ALARMS = {
  dailyRollover: 'daily-rollover',
  lockoutEnd: 'lockout-end',
  /** Per-domain grace-expiry alarms are named `${gracePrefix}${domain}`. */
  gracePrefix: 'grace:',
} as const;
