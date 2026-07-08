import { describe, expect, it } from 'vitest';
import {
  frameIndexForDurations,
  directionRow,
  resolveHurtEffect,
  HURT_DURATION_MS,
  HeartParticles,
  // deprecated helpers retained for the v0.4 engine:
  frameIndexFor,
  resolveEntry,
} from './sprite-engine';
import type { SpriteManifestEntry, SpriteState } from './types';

// ===========================================================================
// frameIndexForDurations — cumulative-duration lookup, looping, reducedMotion
// ===========================================================================

describe('frameIndexForDurations', () => {
  // Uneven durations: frame 0 for [0,100), 1 for [100,150), 2 for [150,350).
  const durs = [100, 50, 200]; // sum = 350

  it('returns 0 at elapsed 0', () => {
    expect(frameIndexForDurations(0, durs)).toBe(0);
  });

  it('honours uneven duration boundaries', () => {
    expect(frameIndexForDurations(99, durs)).toBe(0);
    expect(frameIndexForDurations(100, durs)).toBe(1); // boundary → next frame
    expect(frameIndexForDurations(149, durs)).toBe(1);
    expect(frameIndexForDurations(150, durs)).toBe(2); // boundary → next frame
    expect(frameIndexForDurations(349, durs)).toBe(2);
  });

  it('loops at sum(durations)', () => {
    expect(frameIndexForDurations(350, durs)).toBe(0); // wraps
    expect(frameIndexForDurations(450, durs)).toBe(1); // 450 % 350 = 100
    expect(frameIndexForDurations(700, durs)).toBe(0); // two full loops
  });

  it('doubles every duration under reduced motion', () => {
    // Effective durations become [200,100,400], sum = 700.
    expect(frameIndexForDurations(199, durs, true)).toBe(0);
    expect(frameIndexForDurations(200, durs, true)).toBe(1);
    expect(frameIndexForDurations(299, durs, true)).toBe(1);
    expect(frameIndexForDurations(300, durs, true)).toBe(2);
    expect(frameIndexForDurations(700, durs, true)).toBe(0); // loops at doubled sum
  });

  it('stays at 0 for single-frame or empty animations', () => {
    expect(frameIndexForDurations(9999, [100])).toBe(0);
    expect(frameIndexForDurations(9999, [])).toBe(0);
  });

  it('guards non-positive / non-finite elapsed', () => {
    expect(frameIndexForDurations(-10, durs)).toBe(0);
    expect(frameIndexForDurations(Number.NaN, durs)).toBe(0);
    expect(frameIndexForDurations(Number.POSITIVE_INFINITY, durs)).toBe(2);
  });

  it('ignores non-positive individual durations without crashing', () => {
    // A zero-duration frame collapses; total is driven by valid entries.
    expect(frameIndexForDurations(0, [0, 100])).toBe(0);
    expect(frameIndexForDurations(50, [0, 100])).toBe(1);
  });
});

// ===========================================================================
// directionRow — 8 sector centers + boundaries + zero-vector keep-last
// ===========================================================================

describe('directionRow', () => {
  it('maps the 8 sector centers to PMD_DIRECTION_ROWS indices', () => {
    expect(directionRow(0, 1)).toBe(0); // down
    expect(directionRow(1, 1)).toBe(1); // down-right
    expect(directionRow(1, 0)).toBe(2); // right
    expect(directionRow(1, -1)).toBe(3); // up-right
    expect(directionRow(0, -1)).toBe(4); // up
    expect(directionRow(-1, -1)).toBe(5); // up-left
    expect(directionRow(-1, 0)).toBe(6); // left
    expect(directionRow(-1, 1)).toBe(7); // down-left
  });

  it('is scale-invariant (magnitude does not matter)', () => {
    expect(directionRow(0, 42)).toBe(0);
    expect(directionRow(100, -100)).toBe(3);
    expect(directionRow(-7, 0)).toBe(6);
  });

  it('rounds boundary angles into a neighbouring sector deterministically', () => {
    // A near-cardinal vector snaps to the nearest compass row.
    expect(directionRow(0.01, 1)).toBe(0); // just east of down → still down
    expect(directionRow(1, 0.01)).toBe(2); // just south of right → still right
    // A vector well inside the down-right sector.
    expect(directionRow(2, 3)).toBe(1);
  });

  it('returns -1 for the zero vector (caller keeps last direction)', () => {
    expect(directionRow(0, 0)).toBe(-1);
  });
});

// ===========================================================================
// resolveHurtEffect — auto-expiry back to the previous effect
// ===========================================================================

describe('resolveHurtEffect', () => {
  it('shows hurt within the window then reverts to null', () => {
    expect(resolveHurtEffect(null, 0)).toBe('hurt');
    expect(resolveHurtEffect(null, HURT_DURATION_MS - 1)).toBe('hurt');
    expect(resolveHurtEffect(null, HURT_DURATION_MS)).toBe(null); // boundary reverts
    expect(resolveHurtEffect(null, HURT_DURATION_MS + 500)).toBe(null);
  });

  it('reverts to the PREVIOUS effect (e.g. hurt during desperate → desperate)', () => {
    expect(resolveHurtEffect('desperate', 100)).toBe('hurt'); // still flashing
    expect(resolveHurtEffect('desperate', HURT_DURATION_MS + 1)).toBe('desperate');
  });

  it('respects a custom duration', () => {
    expect(resolveHurtEffect('happy', 150, 200)).toBe('hurt');
    expect(resolveHurtEffect('happy', 200, 200)).toBe('happy');
  });

  it('treats negative elapsed as expired (defensive)', () => {
    expect(resolveHurtEffect('desperate', -1)).toBe('desperate');
  });
});

// ===========================================================================
// HeartParticles — pure particle state machine (no canvas needed)
// ===========================================================================

describe('HeartParticles', () => {
  const seq = (...vals: number[]) => {
    let i = 0;
    return () => vals[i++ % vals.length];
  };

  it('starts empty', () => {
    expect(new HeartParticles().count()).toBe(0);
  });

  it('spawns a heart on demand', () => {
    const hp = new HeartParticles();
    hp.spawn(10, 10, seq(0.5, 0.5, 0.5, 0.5, 0.5));
    expect(hp.count()).toBe(1);
  });

  it('spawns roughly every ~180ms as it advances', () => {
    const hp = new HeartParticles();
    const rand = seq(0.5);
    hp.advance(100, 0, 0, rand);
    expect(hp.count()).toBe(0); // not enough elapsed yet
    hp.advance(100, 0, 0, rand);
    expect(hp.count()).toBe(1); // crossed 180ms → one spawn
  });

  it('culls hearts once they exceed their life', () => {
    const hp = new HeartParticles();
    // life = 900 + rand*500; with rand=0 → 900ms.
    hp.spawn(0, 0, seq(0.5, 0.5, 0.5, 0.5, 0));
    expect(hp.count()).toBe(1);
    // Advance far past life without re-spawning (rand path won't matter since we
    // advance in one big step; a spawn also happens but it too will be young).
    hp.advance(5000, 0, 0, seq(0.5, 0.5, 0.5, 0.5, 0));
    // The original heart (life ~900ms) is dead; the freshly spawned one may live.
    expect(hp.count()).toBeLessThanOrEqual(1);
  });

  it('clear() removes all hearts', () => {
    const hp = new HeartParticles();
    hp.spawn(0, 0, seq(0.5));
    hp.spawn(0, 0, seq(0.5));
    hp.clear();
    expect(hp.count()).toBe(0);
  });
});

// ===========================================================================
// Retained v0.4 helpers (@deprecated) — kept green until Phase 4 deletion
// ===========================================================================

const entry = (
  tier: number,
  state: SpriteState,
  extra: Partial<SpriteManifestEntry> = {},
): SpriteManifestEntry => ({
  tier,
  state,
  sheetUrl: `sprites/${tier}/${state}.png`,
  frameW: 96,
  frameH: 96,
  frames: 6,
  fps: 8,
  ...extra,
});

describe('frameIndexFor (deprecated v0.4)', () => {
  it('returns 0 at time 0', () => {
    expect(frameIndexFor(0, 8, 6)).toBe(0);
  });

  it('advances one frame per 1/fps seconds', () => {
    expect(frameIndexFor(124, 8, 6)).toBe(0);
    expect(frameIndexFor(125, 8, 6)).toBe(1);
    expect(frameIndexFor(250, 8, 6)).toBe(2);
  });

  it('loops modulo frame count', () => {
    expect(frameIndexFor(750, 8, 6)).toBe(0);
    expect(frameIndexFor(875, 8, 6)).toBe(1);
  });

  it('is stable for single-frame animations', () => {
    expect(frameIndexFor(9999, 8, 1)).toBe(0);
  });

  it('halves effective fps under reduced motion', () => {
    expect(frameIndexFor(249, 8, 6, true)).toBe(0);
    expect(frameIndexFor(250, 8, 6, true)).toBe(1);
    expect(frameIndexFor(500, 8, 6, true)).toBe(2);
  });

  it('guards non-positive / non-finite inputs', () => {
    expect(frameIndexFor(-5, 8, 6)).toBe(0);
    expect(frameIndexFor(100, 0, 6)).toBe(0);
    expect(frameIndexFor(100, Number.POSITIVE_INFINITY, 6)).toBe(0);
  });
});

describe('resolveEntry fallback chain (deprecated v0.4)', () => {
  const manifest: SpriteManifestEntry[] = [
    entry(0, 'idle'),
    entry(0, 'run'),
    entry(0, 'happy'),
    entry(0, 'hurt'),
    entry(0, 'desperate'),
    entry(0, 'dead'),
    entry(1, 'idle', { frameW: 112 }),
    entry(1, 'run', { frameW: 112 }),
  ];

  it('returns the exact (tier,state) entry when present', () => {
    expect(resolveEntry(manifest, 1, 'run')).toMatchObject({ tier: 1, state: 'run', frameW: 112 });
  });

  it('falls back to tier 0 same state when tier art is missing', () => {
    expect(resolveEntry(manifest, 1, 'hurt')).toMatchObject({ tier: 0, state: 'hurt' });
  });

  it('falls back to tier 0 idle when neither tier has the state', () => {
    const trimmed = manifest.filter((e) => !(e.tier === 0 && e.state === 'dead'));
    expect(resolveEntry(trimmed, 3, 'dead')).toMatchObject({ tier: 0, state: 'idle' });
  });

  it('returns undefined only when the manifest is empty', () => {
    expect(resolveEntry([], 0, 'idle')).toBeUndefined();
  });

  it('prefers the requested tier over tier 0 for the same state', () => {
    expect(resolveEntry(manifest, 1, 'idle')?.tier).toBe(1);
  });
});
