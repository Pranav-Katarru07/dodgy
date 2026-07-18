import type { BaseAnim, Effect, PokemonSpriteApi } from './types';
import type { SheetRef } from './species';
import { PMD_DIRECTION_ROWS } from './constants';

// ===========================================================================
// v1 sprite engine — PokemonSprite (primary export)
// ===========================================================================
//
// Renders PokémonMysteryDungeon-style grid sprite sheets (columns = animation
// frames, rows = facing direction) onto a Canvas2D context. Timing is driven by
// per-frame `durationsMs` arrays (see SheetRef) accumulated against a wall-clock
// so playback is correct at any refresh rate.
//
// Rendering contract (inherited from v0.4, kept identical so consumers can rely
// on it either way):
//   - renderFrame() draws the current frame WITHOUT clearing the canvas. The
//     caller owns clearing (e.g. a shared canvas with several sprites, or a
//     scene the caller repaints).
//   - start() runs an rAF loop that CLEARS THE FULL CANVAS each tick, then
//     draws. Use start() only when the sprite owns its canvas.
//   - Never throws once load() has resolved. A missing/undecoded image simply
//     skips the draw for that frame.
//
// Effects (hurt / desperate / fainted / happy) are composited through an
// offscreen canvas so tints never bleed onto the caller's canvas.

/** Sheets required by a PokemonSprite: one per base animation. */
export interface PokemonSpriteSheets {
  walk: SheetRef;
  idle: SheetRef;
}

export interface PokemonSpriteOptions {
  /**
   * When true: frame durations are doubled (slower, calmer playback), shake is
   * skipped, and happy hearts are not spawned.
   */
  reducedMotion?: boolean;
  /**
   * Optional URL resolver applied to each sheet's `url` before loading. In an
   * extension, pass `chrome.runtime.getURL`. Defaults to identity.
   */
  resolveUrl?: (url: string) => string;
}

// ---------------------------------------------------------------------------
// Pure frame/direction math (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Given elapsed time (ms) since the current animation began and the per-frame
 * durations array, return the frame index to display.
 *
 * Uses a cumulative-duration lookup and loops at `sum(durations)`.
 * `reducedMotion` doubles every duration (halves playback speed). Non-positive
 * or empty inputs collapse to frame 0. Exported for unit testing.
 */
export function frameIndexForDurations(
  elapsedMs: number,
  durationsMs: number[],
  reducedMotion = false,
): number {
  const n = durationsMs.length;
  if (n <= 1) return 0;

  const mult = reducedMotion ? 2 : 1;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const d = durationsMs[i];
    if (Number.isFinite(d) && d > 0) total += d * mult;
  }
  if (total <= 0) return 0;
  if (Number.isNaN(elapsedMs) || elapsedMs <= 0) return 0;
  // Non-finite (+Infinity) elapsed has no meaningful loop position; treat it as
  // the end of the cycle → last frame (matches the reduce-to-last edge below).
  if (!Number.isFinite(elapsedMs)) return n - 1;

  // Position within the loop.
  const t = elapsedMs % total;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = durationsMs[i];
    const span = Number.isFinite(d) && d > 0 ? d * mult : 0;
    acc += span;
    if (t < acc) return i;
  }
  // Floating-point edge: t === total-ish → last frame.
  return n - 1;
}

/**
 * Map a movement vector to an 8-way PMD direction row index.
 *
 * The angle atan2(dy, dx) is bucketed into 8 sectors of 45° each, centered on
 * the eight compass directions. Screen +y points DOWN, so dy>0 is 'down'.
 * Sectors are mapped through PMD_DIRECTION_ROWS order:
 *   ['down','down-right','right','up-right','up','up-left','left','down-left']
 * A zero vector (0,0) returns -1 so the caller can keep the last direction.
 * Exported for unit testing.
 */
export function directionRow(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return -1;

  // Compass sectors indexed clockwise from 'down' (screen +y). Building a table
  // from PMD_DIRECTION_ROWS keeps this in lockstep with the frozen constant.
  //
  // Reference unit vectors (screen coords, +y down):
  //   down (0,1), down-right (1,1), right (1,0), up-right (1,-1),
  //   up (0,-1), up-left (-1,-1), left (-1,0), down-left (-1,1)
  //
  // The angle of 'down' is atan2(1, 0) = +90°. Each subsequent PMD row rotates
  // by -45° (down-right = +45°, right = 0°, up-right = -45°, ...). So the sector
  // index is: round((90° - angleDeg) / 45°) mod 8.
  const angle = Math.atan2(dy, dx); // radians, +y down
  const deg = (angle * 180) / Math.PI;
  let sector = Math.round((90 - deg) / 45);
  sector = ((sector % PMD_DIRECTION_ROWS.length) + PMD_DIRECTION_ROWS.length) % PMD_DIRECTION_ROWS.length;
  return sector;
}

// ---------------------------------------------------------------------------
// Rising-heart particles for the `happy` effect (no assets; bezier-drawn)
// ---------------------------------------------------------------------------

interface Heart {
  x: number;
  y: number;
  vy: number;
  size: number;
  age: number;
  life: number;
  hue: number;
}

/**
 * A tiny particle system that spawns rising, fading heart shapes near a point.
 * Hearts are drawn with bezier curves — no image assets. Advanced per frame by
 * the sprite's render loop. Under reduced motion the sprite spawns none.
 *
 * Exported so tests (and any future consumer) can drive the pure state machine
 * without a canvas: `spawn`, `advance`, and `count` need no DOM.
 */
export class HeartParticles {
  private hearts: Heart[] = [];
  /** Deterministic-ish spawn cadence accumulator (ms). */
  private sinceSpawn = 0;

  /** Number of live hearts. */
  count(): number {
    return this.hearts.length;
  }

  /** Remove all live hearts. */
  clear(): void {
    this.hearts = [];
    this.sinceSpawn = 0;
  }

  /**
   * Spawn a heart near (x, y). Randomized horizontal offset and upward speed.
   * `rand` is injectable for deterministic tests (defaults to Math.random).
   */
  spawn(x: number, y: number, rand: () => number = Math.random): void {
    this.hearts.push({
      x: x + (rand() - 0.5) * 16,
      y,
      vy: 18 + rand() * 22, // px/sec upward
      size: 5 + rand() * 4,
      age: 0,
      life: 900 + rand() * 500,
      hue: 330 + rand() * 20,
    });
  }

  /**
   * Advance all hearts by `dtMs`, spawning a new one roughly every ~180ms at
   * (x, y). Dead hearts (age >= life) are culled. `rand` injectable for tests.
   */
  advance(dtMs: number, x: number, y: number, rand: () => number = Math.random): void {
    if (!Number.isFinite(dtMs) || dtMs <= 0) dtMs = 0;
    this.sinceSpawn += dtMs;
    if (this.sinceSpawn >= 180) {
      this.sinceSpawn = 0;
      this.spawn(x, y, rand);
    }
    const dtSec = dtMs / 1000;
    for (const h of this.hearts) {
      h.age += dtMs;
      h.y -= h.vy * dtSec;
    }
    this.hearts = this.hearts.filter((h) => h.age < h.life);
  }

  /** Draw all hearts onto ctx (canvas coordinates). Never throws. */
  draw(ctx: CanvasRenderingContext2D): void {
    for (const h of this.hearts) {
      const alpha = Math.max(0, 1 - h.age / h.life);
      drawHeart(ctx, h.x, h.y, h.size, h.hue, alpha);
    }
  }
}

function drawHeart(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  hue: number,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = `hsl(${hue}, 80%, 62%)`;
  ctx.beginPath();
  // Classic two-lobe heart via beziers, centered on (x, y).
  const top = y - s * 0.3;
  ctx.moveTo(x, y + s * 0.6);
  ctx.bezierCurveTo(x - s, y - s * 0.2, x - s * 0.5, top - s * 0.7, x, top);
  ctx.bezierCurveTo(x + s * 0.5, top - s * 0.7, x + s, y - s * 0.2, x, y + s * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Effect timing helper (pure; exported for unit testing)
// ---------------------------------------------------------------------------

/** Duration a `hurt` flash lasts before auto-reverting to the prior effect. */
export const HURT_DURATION_MS = 600;

/**
 * Given the effect that was active when `hurt` began (`previous`), the elapsed
 * time since hurt started, and the duration, decide the effect that should be
 * shown now: `hurt` while within the window, otherwise the previous effect.
 * Pure — exercised directly by tests. `previous` must not itself be 'hurt'.
 */
export function resolveHurtEffect(
  previous: Effect,
  elapsedMs: number,
  durationMs = HURT_DURATION_MS,
): Effect {
  if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < durationMs) {
    return 'hurt';
  }
  return previous;
}

// ---------------------------------------------------------------------------
// PokemonSprite
// ---------------------------------------------------------------------------

export class PokemonSprite implements PokemonSpriteApi {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  private readonly sheets: PokemonSpriteSheets;
  private readonly resolveUrl: (url: string) => string;
  private reducedMotion: boolean;

  /** Loaded images keyed by resolved URL. */
  private readonly images = new Map<string, HTMLImageElement>();

  private anim: BaseAnim = 'idle';
  /** Row index for the current facing (0..7), or 0 for flat sheets. */
  private row = 0;
  /** Last horizontal direction was leftward — used by flat (directions===1) sheets. */
  private facingLeft = false;

  private x = 0;
  private y = 0;
  private scale = 1;

  // Effect state.
  private effect: Effect = null;
  /** For `hurt`: the effect to revert to when the flash expires. */
  private hurtPrevious: Effect = null;
  /** now() at which the current `hurt` began. */
  private hurtStart = 0;
  private readonly hearts = new HeartParticles();

  // Clocks.
  private animStart = 0;
  private lastRender = 0;

  private running = false;
  private rafId = 0;

  // Offscreen compositing surface (lazily sized).
  private offscreen: HTMLCanvasElement | null = null;
  private offctx: CanvasRenderingContext2D | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    sheets: PokemonSpriteSheets,
    options: PokemonSpriteOptions = {},
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('PokemonSprite: 2D canvas context unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
    this.sheets = sheets;
    this.reducedMotion = options.reducedMotion ?? false;
    this.resolveUrl = options.resolveUrl ?? ((u) => u);
    this.animStart = this.now();
    this.lastRender = this.now();
  }

  /**
   * Load both sheets. Each is an Image() whose src is the resolved URL; onerror
   * RESOLVES (never rejects) so a missing sheet just skips its draws. Resolves
   * when every image has settled.
   */
  async load(): Promise<void> {
    const urls = new Set<string>();
    urls.add(this.resolveUrl(this.sheets.walk.url));
    urls.add(this.resolveUrl(this.sheets.idle.url));
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
      img.onerror = () => resolve(); // leave unset; render falls back to no-draw
      img.src = url;
    });
  }

  /** Set the base looping animation; resets the frame clock only on change. */
  setAnim(anim: BaseAnim): void {
    if (anim === this.anim) return;
    this.anim = anim;
    this.animStart = this.now();
  }

  /**
   * Point the sprite along a movement vector. Picks the 8-way PMD row via
   * directionRow(). A zero vector keeps the last direction. For flat sheets
   * (directions===1) the row is forced to 0 and horizontal facing is tracked so
   * renderFrame can flip left-moving frames.
   */
  setDirection(dx: number, dy: number): void {
    const r = directionRow(dx, dy);
    if (r === -1) return; // (0,0): keep last direction
    this.row = r;
    if (dx < 0) this.facingLeft = true;
    else if (dx > 0) this.facingLeft = false;
  }

  /**
   * Apply (or clear, with null) a transient effect.
   *   - hurt: auto-expires after ~600ms back to the PREVIOUS effect.
   *   - fainted: freezes on the first idle frame.
   *   - happy: spawns rising hearts (none under reduced motion).
   */
  setEffect(effect: Effect): void {
    if (effect === 'hurt') {
      // Only capture the previous effect if we're not already hurting, so a
      // re-trigger mid-flash refreshes the timer without losing the base.
      if (this.effect !== 'hurt') this.hurtPrevious = this.effect;
      this.hurtStart = this.now();
      this.effect = 'hurt';
      return;
    }
    if (effect !== 'happy') this.hearts.clear();
    this.effect = effect;
    this.hurtPrevious = null;
  }

  /** Effect actually shown this frame (resolves hurt auto-expiry). */
  private effectiveEffect(): Effect {
    if (this.effect === 'hurt') {
      const resolved = resolveHurtEffect(this.hurtPrevious, this.now() - this.hurtStart);
      if (resolved !== 'hurt') {
        // Commit the reversion so timing state is not re-evaluated forever.
        this.effect = resolved;
        this.hurtPrevious = null;
      }
      return resolved;
    }
    return this.effect;
  }

  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  setScale(scale: number): void {
    this.scale = scale;
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  getAnim(): BaseAnim {
    return this.anim;
  }

  getEffect(): Effect {
    return this.effect;
  }

  /** Begin the render loop. Clears the FULL canvas each tick, then draws. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.animStart = this.now();
    this.lastRender = this.now();
    const tick = () => {
      if (!this.running) return;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.renderFrame();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Stop the render loop. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.rafId);
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * Draw the current frame once, WITHOUT clearing (the caller owns clearing).
   * Never throws once load() has resolved.
   */
  renderFrame(): void {
    const t = this.now();
    const dt = t - this.lastRender;
    this.lastRender = t;

    const eff = this.effectiveEffect();

    // Choose sheet: fainted always freezes on idle sheet's first frame.
    const fainted = eff === 'fainted';
    const sheet = fainted || this.anim === 'idle' ? this.sheets.idle : this.sheets.walk;
    const img = this.images.get(this.resolveUrl(sheet.url));

    // Frame index.
    let frame = 0;
    if (!fainted) {
      const elapsed = t - this.animStart;
      frame = frameIndexForDurations(elapsed, sheet.durationsMs, this.reducedMotion);
    }

    // Row: 8-way sheets use this.row; flat sheets use row 0 (+ flip).
    const directions = sheet.directions;
    const row = directions >= 8 ? this.row : 0;
    const flip = directions <= 1 && this.facingLeft;

    // Advance heart particles for happy (spawn suppressed under reduced motion).
    if (eff === 'happy' && !this.reducedMotion) {
      this.hearts.advance(dt, this.x, this.y - (sheet.frameH * this.scale) / 2);
    } else if (eff !== 'happy') {
      this.hearts.clear();
    }

    const drawable = img != null && img.width > 0 && img.height > 0;

    // Fast path: no effect (or an effect that only overlays), draw directly.
    if (eff == null) {
      if (drawable) this.blitDirect(img as HTMLImageElement, sheet, frame, row, flip, 0, 0);
      return;
    }

    // Effect path: render frame to offscreen, composite, blit.
    if (!drawable) {
      // Still draw happy hearts even if the frame image is missing.
      if (eff === 'happy') this.hearts.draw(this.ctx);
      return;
    }
    this.renderWithEffect(img as HTMLImageElement, sheet, frame, row, flip, eff, t);
  }

  /** Direct frame blit (no compositing). shakeX/shakeY offset the position. */
  private blitDirect(
    img: HTMLImageElement,
    sheet: SheetRef,
    frame: number,
    row: number,
    flip: boolean,
    shakeX: number,
    shakeY: number,
  ): void {
    const ctx = this.ctx;
    const dw = sheet.frameW * this.scale;
    const dh = sheet.frameH * this.scale;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(this.x + shakeX, this.y + shakeY);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(
      img,
      frame * sheet.frameW,
      row * sheet.frameH,
      sheet.frameW,
      sheet.frameH,
      -dw / 2,
      -dh / 2,
      dw,
      dh,
    );
    ctx.restore();
  }

  private ensureOffscreen(w: number, h: number): CanvasRenderingContext2D | null {
    if (!this.offscreen) {
      // document may be unavailable (SW) — guard so we never throw.
      if (typeof document === 'undefined') return null;
      this.offscreen = document.createElement('canvas');
      this.offctx = this.offscreen.getContext('2d');
    }
    if (!this.offctx) return null;
    if (this.offscreen!.width !== w || this.offscreen!.height !== h) {
      this.offscreen!.width = w;
      this.offscreen!.height = h;
    }
    return this.offctx;
  }

  /**
   * Render one frame with a tint/grayscale effect via an offscreen canvas so
   * the tint never bleeds onto the caller's surface, then blit the result.
   */
  private renderWithEffect(
    img: HTMLImageElement,
    sheet: SheetRef,
    frame: number,
    row: number,
    flip: boolean,
    eff: Effect,
    t: number,
  ): void {
    const dw = sheet.frameW * this.scale;
    const dh = sheet.frameH * this.scale;
    const off = this.ensureOffscreen(sheet.frameW, sheet.frameH);

    // If no offscreen surface is available, degrade to a direct draw (still
    // never throws; just no tint).
    if (!off) {
      const shake = this.computeShake(eff, t);
      this.blitDirect(img, sheet, frame, row, flip, shake.x, shake.y);
      if (eff === 'happy') this.hearts.draw(this.ctx);
      return;
    }

    // 1. Draw the raw frame to the offscreen (native frame size).
    off.clearRect(0, 0, sheet.frameW, sheet.frameH);
    off.imageSmoothingEnabled = false;
    off.globalCompositeOperation = 'source-over';
    off.globalAlpha = 1;
    off.drawImage(
      img,
      frame * sheet.frameW,
      row * sheet.frameH,
      sheet.frameW,
      sheet.frameH,
      0,
      0,
      sheet.frameW,
      sheet.frameH,
    );

    // 2. Composite the tint (only where the sprite is opaque).
    if (eff === 'hurt') {
      // sin-based white flash 0 → 0.8.
      const phase = (t - this.hurtStart) / HURT_DURATION_MS; // 0..1
      const alpha = Math.abs(Math.sin(phase * Math.PI * 3)) * 0.8;
      off.globalCompositeOperation = 'source-atop';
      off.globalAlpha = alpha;
      off.fillStyle = '#ffffff';
      off.fillRect(0, 0, sheet.frameW, sheet.frameH);
    } else if (eff === 'desperate') {
      off.globalCompositeOperation = 'source-atop';
      off.globalAlpha = 0.25;
      off.fillStyle = '#ff0000';
      off.fillRect(0, 0, sheet.frameW, sheet.frameH);
    }
    off.globalCompositeOperation = 'source-over';
    off.globalAlpha = 1;

    // 3. Blit to the caller's canvas.
    const shake = this.computeShake(eff, t);
    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (eff === 'fainted') ctx.filter = 'grayscale(1)';
    ctx.translate(this.x + shake.x, this.y + shake.y);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(this.offscreen!, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();

    // 4. Overlay effects that live on the caller's canvas (hearts).
    if (eff === 'happy') this.hearts.draw(this.ctx);
  }

  /** ±3px shake for hurt; zero otherwise (and under reduced motion). */
  private computeShake(eff: Effect, t: number): { x: number; y: number } {
    if (eff !== 'hurt' || this.reducedMotion) return { x: 0, y: 0 };
    // Two out-of-phase oscillations for a jittery feel.
    const x = Math.round(Math.sin(t / 18) * 3);
    const y = Math.round(Math.cos(t / 13) * 3);
    return { x, y };
  }
}
