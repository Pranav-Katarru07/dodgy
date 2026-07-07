import { describe, expect, it } from 'vitest';
import { frameIndexFor, resolveEntry } from './sprite-engine';
import type { SpriteManifestEntry, SpriteState } from './types';

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

describe('frameIndexFor', () => {
  it('returns 0 at time 0', () => {
    expect(frameIndexFor(0, 8, 6)).toBe(0);
  });

  it('advances one frame per 1/fps seconds', () => {
    // 8 fps => 125ms per frame
    expect(frameIndexFor(124, 8, 6)).toBe(0);
    expect(frameIndexFor(125, 8, 6)).toBe(1);
    expect(frameIndexFor(250, 8, 6)).toBe(2);
  });

  it('loops modulo frame count', () => {
    // 6 frames at 8fps => full loop is 750ms; frame at 750ms wraps to 0
    expect(frameIndexFor(750, 8, 6)).toBe(0);
    expect(frameIndexFor(875, 8, 6)).toBe(1);
  });

  it('is stable (single-frame animations stay at 0)', () => {
    expect(frameIndexFor(9999, 8, 1)).toBe(0);
  });

  it('halves effective fps under reduced motion', () => {
    // reduced 8fps => 4fps => 250ms per frame
    expect(frameIndexFor(249, 8, 6, true)).toBe(0);
    expect(frameIndexFor(250, 8, 6, true)).toBe(1);
    expect(frameIndexFor(500, 8, 6, true)).toBe(2);
  });

  it('guards against non-positive / non-finite inputs', () => {
    expect(frameIndexFor(-5, 8, 6)).toBe(0);
    expect(frameIndexFor(100, 0, 6)).toBe(0);
    expect(frameIndexFor(100, Number.POSITIVE_INFINITY, 6)).toBe(0);
  });
});

describe('resolveEntry fallback chain', () => {
  const manifest: SpriteManifestEntry[] = [
    entry(0, 'idle'),
    entry(0, 'run'),
    entry(0, 'happy'),
    entry(0, 'hurt'),
    entry(0, 'desperate'),
    entry(0, 'dead'),
    // tier 1 intentionally missing 'hurt' to exercise same-state tier-0 fallback
    entry(1, 'idle', { frameW: 112 }),
    entry(1, 'run', { frameW: 112 }),
  ];

  it('returns the exact (tier,state) entry when present', () => {
    const e = resolveEntry(manifest, 1, 'run');
    expect(e).toMatchObject({ tier: 1, state: 'run', frameW: 112 });
  });

  it('falls back to tier 0 same state when tier art is missing', () => {
    const e = resolveEntry(manifest, 1, 'hurt');
    expect(e).toMatchObject({ tier: 0, state: 'hurt' });
  });

  it('falls back to tier 0 idle when neither tier has the state', () => {
    // request a tier/state combination absent for both: tier 5 has nothing,
    // and pretend a state has no tier-0 entry by using a trimmed manifest.
    const trimmed = manifest.filter((e) => !(e.tier === 0 && e.state === 'dead'));
    const e = resolveEntry(trimmed, 3, 'dead');
    expect(e).toMatchObject({ tier: 0, state: 'idle' });
  });

  it('returns undefined only when the manifest is empty', () => {
    expect(resolveEntry([], 0, 'idle')).toBeUndefined();
  });

  it('prefers the requested tier over tier 0 for the same state', () => {
    const e = resolveEntry(manifest, 1, 'idle');
    expect(e?.tier).toBe(1);
  });
});
