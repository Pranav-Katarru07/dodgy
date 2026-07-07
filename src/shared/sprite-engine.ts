import type { SpriteManifestEntry, SpriteState } from './types';

/**
 * Config-driven, swappable sprite-sheet animation engine.
 *
 * Renders horizontal-strip sprite sheets (one row of frames per state/tier)
 * onto a Canvas2D context. Evolution tiers are swapped at runtime by
 * {@link SpriteEngine.setTier}; the manifest ({@link SpriteManifestEntry}[])
 * is the single source of truth for geometry and timing.
 *
 * Frame timing is accumulator-based, derived from wall-clock deltas, so it is
 * correct at any display refresh rate (60/120/144 Hz) and independent of how
 * often requestAnimationFrame fires.
 *
 * Fallback chain for a missing (tier, state): tier 0 same state → tier 0
 * 'idle'. Rendering never throws once {@link SpriteEngine.load} has resolved.
 */

const ALL_STATES: readonly SpriteState[] = [
  'idle',
  'run',
  'happy',
  'hurt',
  'desperate',
  'dead',
];

export interface SpriteEngineOptions {
  /** When true: effective fps is halved and shake/jitter offsets are skipped. */
  reducedMotion?: boolean;
  /**
   * Optional URL resolver applied to each entry's `sheetUrl` before loading.
   * In an extension, pass `chrome.runtime.getURL`. Defaults to identity.
   */
  resolveUrl?: (sheetUrl: string) => string;
}

/**
 * Pure helper: given elapsed time (ms) since the current state began, the
 * animation fps, and the frame count, return the frame index to display.
 *
 * Loops indefinitely. `reducedMotion` halves the effective fps (slower,
 * calmer playback). Exported for unit testing.
 */
export function frameIndexFor(
  elapsedMs: number,
  fps: number,
  frames: number,
  reducedMotion = false,
): number {
  if (frames <= 1) return 0;
  const effFps = reducedMotion ? fps / 2 : fps;
  if (effFps <= 0 || !Number.isFinite(effFps)) return 0;
  if (elapsedMs <= 0) return 0;
  const frame = Math.floor((elapsedMs / 1000) * effFps);
  return ((frame % frames) + frames) % frames;
}

/**
 * Pure helper: resolve the manifest entry to actually render for a requested
 * (tier, state), applying the fallback chain. Returns `undefined` only if the
 * manifest has no tier-0 entries at all.
 *
 * Exported for unit testing.
 */
export function resolveEntry(
  manifest: SpriteManifestEntry[],
  tier: number,
  state: SpriteState,
): SpriteManifestEntry | undefined {
  return (
    find(manifest, tier, state) ??
    find(manifest, 0, state) ??
    find(manifest, 0, 'idle')
  );
}

function find(
  manifest: SpriteManifestEntry[],
  tier: number,
  state: SpriteState,
): SpriteManifestEntry | undefined {
  return manifest.find((e) => e.tier === tier && e.state === state);
}

type ImageLike = { readonly width: number; readonly height: number };

export class SpriteEngine {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly manifest: SpriteManifestEntry[];
  private readonly resolveUrl: (sheetUrl: string) => string;

  private reducedMotion: boolean;

  /** Loaded images keyed by resolved sheet URL. */
  private readonly images = new Map<string, HTMLImageElement>();
  /** Tiers whose sheets have been requested/preloaded. */
  private readonly loadedTiers = new Set<number>();

  private tier = 0;
  private state: SpriteState = 'idle';

  private x = 0;
  private y = 0;
  private scale = 1;
  private flipX = false;

  private running = false;
  private rafId = 0;
  private stateStart = 0;

  constructor(
    canvas: HTMLCanvasElement,
    manifest: SpriteManifestEntry[],
    options: SpriteEngineOptions = {},
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('SpriteEngine: 2D canvas context unavailable');
    this.ctx = ctx;
    this.manifest = manifest;
    this.reducedMotion = options.reducedMotion ?? false;
    this.resolveUrl = options.resolveUrl ?? ((u) => u);
  }

  /** Static helper: fetch and parse a manifest JSON file. */
  static async loadManifest(url: string): Promise<SpriteManifestEntry[]> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`SpriteEngine.loadManifest: HTTP ${res.status} for ${url}`);
    }
    const data = (await res.json()) as SpriteManifestEntry[];
    if (!Array.isArray(data)) {
      throw new Error('SpriteEngine.loadManifest: manifest is not an array');
    }
    return data;
  }

  /**
   * Preload every sheet needed for `tier` (all six states), resolving once all
   * decode. Missing/failed images are skipped, not fatal — the fallback chain
   * covers them at render time. Also implicitly preloads tier 0 (the ultimate
   * fallback) so rendering is always safe.
   */
  async load(tier: number): Promise<void> {
    const urls = new Set<string>();
    for (const t of tier === 0 ? [0] : [tier, 0]) {
      for (const s of ALL_STATES) {
        const entry = find(this.manifest, t, s);
        if (entry) urls.add(this.resolveUrl(entry.sheetUrl));
      }
      this.loadedTiers.add(t);
    }
    await Promise.all([...urls].map((u) => this.loadImage(u)));
  }

  private loadImage(url: string): Promise<void> {
    if (this.images.has(url)) return Promise.resolve();
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.images.set(url, img);
        resolve();
      };
      img.onerror = () => {
        // Leave it unset; render falls back. Never reject.
        resolve();
      };
      img.src = url;
    });
  }

  /** Switch animation state and reset the frame clock. */
  setState(state: SpriteState): void {
    if (state === this.state) return;
    this.state = state;
    this.stateStart = this.now();
  }

  /** Swap evolution art, loading the tier's sheets if not already present. */
  async setTier(tier: number): Promise<void> {
    if (tier === this.tier && this.loadedTiers.has(tier)) return;
    this.tier = tier;
    if (!this.loadedTiers.has(tier)) await this.load(tier);
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  setScale(s: number): void {
    this.scale = s;
  }

  /** Face left/right — chase uses this to flip toward travel direction. */
  setFlipX(flip: boolean): void {
    this.flipX = flip;
  }

  getState(): SpriteState {
    return this.state;
  }

  getTier(): number {
    return this.tier;
  }

  /** Begin the rAF render loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stateStart = this.now();
    const tick = () => {
      if (!this.running) return;
      this.renderFrame();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Stop the render loop. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * Draw the current frame once. Public so consumers driving their own loop
   * (or wanting a single paint) can call it directly. Never throws.
   */
  renderFrame(): void {
    const t = this.now();
    const entry = resolveEntry(this.manifest, this.tier, this.state);
    if (!entry) return; // nothing renderable in the manifest

    const img = this.images.get(this.resolveUrl(entry.sheetUrl));
    const elapsed = t - this.stateStart;
    const frame = frameIndexFor(elapsed, entry.fps, entry.frames, this.reducedMotion);

    const ctx = this.ctx;
    const dw = entry.frameW * this.scale;
    const dh = entry.frameH * this.scale;

    ctx.save();
    ctx.translate(this.x, this.y);
    if (this.flipX) ctx.scale(-1, 1);
    ctx.imageSmoothingEnabled = false;

    if (img && this.isDrawable(img)) {
      ctx.drawImage(
        img,
        frame * entry.frameW,
        0,
        entry.frameW,
        entry.frameH,
        -dw / 2,
        -dh / 2,
        dw,
        dh,
      );
    }
    // If the image is missing/undecoded we simply draw nothing this frame
    // rather than throw; a later frame paints once it loads.
    ctx.restore();
  }

  private isDrawable(img: ImageLike): boolean {
    return img.width > 0 && img.height > 0;
  }
}
