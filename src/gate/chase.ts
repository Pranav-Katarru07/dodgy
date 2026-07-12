import type { PokemonSprite } from '../shared/sprite-engine';

/**
 * The chase: the guardian flees the cursor across the full viewport at 60fps.
 *
 * Each frame it steers along normalize(pos - cursorPos) at the current speed,
 * plus a slowly-drifting wander angle so motion isn't perfectly predictable,
 * clamped to the viewport with soft edge-repulsion so it never corner-pins.
 * Desperate raises base speed and steering snappiness.
 *
 * Sprite integration drives a PokemonSprite:
 *   - setAnim('walk') while the guardian is moving, 'idle' once the cursor goes
 *     still (so it stops walking in place when you stop chasing).
 *   - setDirection(vx, vy) every tick picks the 8-way PMD facing row from the
 *     current velocity vector.
 *   - setEffect('desperate') is applied once at construction when the guardian
 *     is low on HP (red tint); the physics desperate speedup constants stay.
 *
 * AUTO-EASE: after a difficulty-scaled delay ({@link easeStartMsFor}, 15s–60s)
 * of chasing without a catch, speed eases over {@link EASE_DURATION_MS} down to
 * {@link EASE_FLOOR} of base so no one is hard-stuck — the rescue exists at every
 * difficulty. Max speed is always capped.
 *
 * Catch = a pointerdown whose point lands within a generous circular hitbox
 * around the sprite center.
 */

export interface ChaseOptions {
  canvas: HTMLCanvasElement;
  sprite: PokemonSprite;
  desperate: boolean;
  reducedMotion: boolean;
  /** Called once, when the guardian is caught by a pointer click. */
  onCatch: () => void;
  /** Called each time a click misses the sprite (drives the a11y fallback). */
  onMiss?: (missCount: number) => void;
  /**
   * Chase difficulty 1..10 (default 5). Scales speed, steering, wander, and the
   * auto-ease delay. d=5 reproduces the historical (pre-slider) feel exactly.
   */
  difficulty?: number;
}

/** Sprite hitbox radius in CSS px (generous, per spec). */
const HIT_RADIUS = 64;
/** Integer draw scale — native PMD frames are ~24-40px; 3× reads well. */
const SPRITE_SCALE = 3;

const BASE_SPEED = 320; // px/s
const DESPERATE_SPEED = 470;
const BASE_MAX_SPEED = 620; // hard cap at difficulty 5 (historical value)
const BASE_STEER = 6.5; // steering responsiveness (1/s)
const DESPERATE_STEER = 10;

const EASE_DURATION_MS = 10_000;
const EASE_FLOOR = 0.4;

/** How far from an edge the soft-repulsion force begins (px). */
const EDGE_MARGIN = 120;
const EDGE_FORCE = 900; // px/s^2 near the very edge

/** Speed (px/s) below which the guardian is considered idle (stop walking). */
const IDLE_SPEED_EPSILON = 8;

/**
 * Difficulty → physics multiplier. Anchored so d=5 → 1.0 (historical feel):
 * d1→0.68, d5→1.0, d10→1.4. Applied to base+desperate speed and steer rate.
 */
export function difficultyMultiplier(difficulty: number): number {
  const d = clampDifficulty(difficulty);
  return 0.6 + d * 0.08;
}

/**
 * Difficulty → auto-ease start delay (ms). Piecewise-linear through the three
 * anchors (1, 15000), (5, 30000), (10, 60000): higher difficulty tires later.
 */
export function easeStartMsFor(difficulty: number): number {
  const d = clampDifficulty(difficulty);
  if (d <= 5) {
    // (1,15000) -> (5,30000)
    return 15_000 + ((d - 1) / 4) * (30_000 - 15_000);
  }
  // (5,30000) -> (10,60000)
  return 30_000 + ((d - 5) / 5) * (60_000 - 30_000);
}

/** Defensive clamp of a difficulty value to an integer in [1, 10]. */
export function clampDifficulty(difficulty: number): number {
  if (!Number.isFinite(difficulty)) return 5;
  return Math.min(10, Math.max(1, Math.round(difficulty)));
}

/**
 * Tangential wall-escape heading (corner-pin fix).
 *
 * When the sprite is trapped against a wall or in a corner, the naive
 * "flee straight away from the cursor" heading points off-screen INTO the
 * pocket, where the per-axis edge/clamp forces fight each other and the sprite
 * jitters forever. This helper detects that geometry and returns a heading that
 * slides the sprite ALONG the wall, away from the cursor, so it can escape.
 *
 * @param px,py  sprite center
 * @param cx,cy  cursor position
 * @param w,h    viewport size
 * @param margin edge band width (px) — the corner/wall zone
 * @returns a corrected desired heading (radians) when escape logic applies,
 *          else `null` (open field — caller keeps its flee heading untouched).
 *
 * Pure & deterministic: no state, no wander. Unit-tested in chase.test.ts.
 */
export function escapeHeading(
  px: number,
  py: number,
  cx: number,
  cy: number,
  w: number,
  h: number,
  margin: number,
): number | null {
  // Distance into each wall band (0 = at wall, margin = at band edge, >margin = clear).
  const distLeft = px;
  const distRight = w - px;
  const distTop = py;
  const distBottom = h - py;

  const nearLeft = distLeft < margin;
  const nearRight = distRight < margin;
  const nearTop = distTop < margin;
  const nearBottom = distBottom < margin;

  const nearVWall = nearLeft || nearRight; // a vertical (left/right) wall
  const nearHWall = nearTop || nearBottom; // a horizontal (top/bottom) wall

  // Raw flee heading (straight away from cursor).
  let fleeX = px - cx;
  let fleeY = py - cy;
  const fleeLen = Math.hypot(fleeX, fleeY) || 1;
  fleeX /= fleeLen;
  fleeY /= fleeLen;

  // Does the flee heading drive the sprite further OUT of bounds through a
  // nearby wall? (e.g. near the left wall and flee still points left.)
  const fleeOutLeft = nearLeft && fleeX < 0;
  const fleeOutRight = nearRight && fleeX > 0;
  const fleeOutTop = nearTop && fleeY < 0;
  const fleeOutBottom = nearBottom && fleeY > 0;
  const fleePointsOut = fleeOutLeft || fleeOutRight || fleeOutTop || fleeOutBottom;

  const inCorner = nearVWall && nearHWall;

  // Escape applies in the corner zone, or when the flee heading would push the
  // sprite out through a nearby wall. Otherwise open field: leave flee alone.
  if (!inCorner && !fleePointsOut) return null;

  // Pick the wall to slide along. In a corner we slide along whichever wall we
  // are DEEPER into (the tighter one) so we peel out of the pocket; on a single
  // wall it's that wall. The wall's inward normal is (nx, ny); the tangent is
  // perpendicular to it (±90°).
  let nx = 0;
  let ny = 0;
  if (nearVWall && (!nearHWall || Math.min(distLeft, distRight) <= Math.min(distTop, distBottom))) {
    // Vertical wall dominates: normal points horizontally inward.
    nx = nearLeft ? 1 : -1;
    ny = 0;
  } else {
    // Horizontal wall: normal points vertically inward.
    nx = 0;
    ny = nearTop ? 1 : -1;
  }

  // Two tangent candidates (rotate normal ±90°): (-ny, nx) and (ny, -nx).
  const tAx = -ny;
  const tAy = nx;
  const tBx = ny;
  const tBy = -nx;

  // Choose the tangent that increases distance from the cursor: the one whose
  // dot with (pos - cursor) is larger (moves away from the cursor along wall).
  const awayX = px - cx;
  const awayY = py - cy;
  const dotA = tAx * awayX + tAy * awayY;
  const dotB = tBx * awayX + tBy * awayY;
  let tx = dotA >= dotB ? tAx : tBx;
  let ty = dotA >= dotB ? tAy : tBy;

  // Corner guard: sliding along one wall must not drive the sprite out through
  // the PERPENDICULAR wall. If the chosen tangent points out that wall, flip it
  // (the along-wall direction that heads back into bounds always exists).
  if (inCorner) {
    if (ny === 0) {
      // Vertical-wall tangent moves along y; keep it off the near horizontal wall.
      if (nearTop && ty < 0) ty = -ty;
      else if (nearBottom && ty > 0) ty = -ty;
    } else {
      // Horizontal-wall tangent moves along x; keep it off the near vertical wall.
      if (nearLeft && tx < 0) tx = -tx;
      else if (nearRight && tx > 0) tx = -tx;
    }
  }
  const tangentHeading = Math.atan2(ty, tx);

  if (!inCorner) {
    // On a straight wall with flee pointing out: redirect fully along the wall.
    return tangentHeading;
  }

  // In the corner: blend a SANITIZED flee → tangent by corner-proximity t² so
  // the effect fades out smoothly toward the band edge (open-field behavior
  // untouched). Sanitize = reflect any flee component that points out through a
  // nearby wall back inward, so the blend never leaks an out-of-bounds heading.
  let safeFleeX = fleeX;
  let safeFleeY = fleeY;
  if (fleeOutLeft) safeFleeX = Math.abs(safeFleeX);
  else if (fleeOutRight) safeFleeX = -Math.abs(safeFleeX);
  if (fleeOutTop) safeFleeY = Math.abs(safeFleeY);
  else if (fleeOutBottom) safeFleeY = -Math.abs(safeFleeY);
  const safeFleeHeading = Math.atan2(safeFleeY, safeFleeX);

  // t = 1 deep in the pocket (both axes at the wall), 0 at the band edge.
  const tv = 1 - Math.min(distLeft, distRight) / margin;
  const th = 1 - Math.min(distTop, distBottom) / margin;
  const t = Math.min(1, Math.max(0, Math.min(tv, th)));
  const blend = t * t;

  return lerpAngle(safeFleeHeading, tangentHeading, blend);
}

/** Shortest-path angular interpolation between two headings (radians). */
export function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  return a + diff * t;
}

export class Chase {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly sprite: PokemonSprite;
  private readonly desperate: boolean;
  private readonly reducedMotion: boolean;
  private readonly onCatch: () => void;
  private readonly onMiss?: (missCount: number) => void;

  private readonly baseSpeed: number;
  private readonly steerRate: number;
  private readonly maxSpeed: number;
  private readonly easeStartMs: number;
  private readonly wanderScale: number;

  private x = 0;
  private y = 0;
  private vx = 0;
  private vy = 0;
  private heading = 0; // radians, current travel direction
  private wanderPhase = Math.random() * Math.PI * 2;
  private wanderRate = 0.6 + Math.random() * 0.4;

  private cursorX = 0;
  private cursorY = 0;
  /** Last-observed cursor position, to detect a still cursor → idle anim. */
  private prevCursorX = 0;
  private prevCursorY = 0;
  private cursorStillMs = 0;

  private startTime = 0;
  private lastTime = 0;
  private running = false;
  private rafId = 0;
  private missCount = 0;
  private caught = false;
  private walking = false;

  private dpr = 1;

  constructor(opts: ChaseOptions) {
    this.canvas = opts.canvas;
    this.ctx = opts.canvas.getContext('2d');
    this.sprite = opts.sprite;
    this.desperate = opts.desperate;
    this.reducedMotion = opts.reducedMotion;
    this.onCatch = opts.onCatch;
    this.onMiss = opts.onMiss;

    // --- Difficulty-driven physics. d=5 → multiplier 1.0 (historical feel). ---
    const d = clampDifficulty(opts.difficulty ?? 5);
    const m = difficultyMultiplier(d);
    this.baseSpeed = (opts.desperate ? DESPERATE_SPEED : BASE_SPEED) * m;
    this.steerRate = (opts.desperate ? DESPERATE_STEER : BASE_STEER) * m;
    // Cap scales with speed so d10-desperate isn't flattened; at d=5, m=1 so the
    // cap is exactly the historical 620 (nothing at d5 reaches it anyway).
    this.maxSpeed = Math.max(BASE_MAX_SPEED, BASE_MAX_SPEED * m);
    this.easeStartMs = easeStartMsFor(d);
    // Wander amplitude scales mildly with difficulty: ×(0.8 + d*0.04) → d5 = 1.0.
    this.wanderScale = 0.8 + d * 0.04;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.resize();
    window.addEventListener('resize', this.resize);

    // Spawn away from center-ish and default cursor at center.
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.x = w * (0.25 + Math.random() * 0.5);
    this.y = h * (0.25 + Math.random() * 0.5);
    this.cursorX = w / 2;
    this.cursorY = h / 2;
    this.prevCursorX = this.cursorX;
    this.prevCursorY = this.cursorY;
    this.heading = Math.random() * Math.PI * 2;

    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);

    this.sprite.setScale(SPRITE_SCALE);
    this.sprite.setAnim('walk');
    this.walking = true;
    // Desperate is a persistent tint for the whole low-HP chase.
    if (this.desperate) this.sprite.setEffect('desperate');
    // We drive rendering ourselves from tick() so we can clear the full-viewport
    // canvas before each paint (the sprite only draws, never clears). Do NOT
    // call sprite.start() here or two rAF loops fight over one canvas.

    const now = performance.now();
    this.startTime = now;
    this.lastTime = now;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.resize);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.sprite.stop();
    this.ctx?.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  /** Current sprite center in CSS px — for external hit tests / handoff. */
  getPosition(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  private resize = (): void => {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    const ctx = this.canvas.getContext('2d');
    if (ctx) ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.cursorX = e.clientX;
    this.cursorY = e.clientY;
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (this.caught) return;
    const dx = e.clientX - this.x;
    const dy = e.clientY - this.y;
    if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) {
      this.caught = true;
      this.onCatch();
    } else {
      this.missCount += 1;
      this.onMiss?.(this.missCount);
    }
  };

  /** Ease multiplier in [EASE_FLOOR, 1] based on elapsed chase time. */
  private easeFactor(elapsedMs: number): number {
    if (elapsedMs <= this.easeStartMs) return 1;
    const t = Math.min((elapsedMs - this.easeStartMs) / EASE_DURATION_MS, 1);
    return 1 - (1 - EASE_FLOOR) * t;
  }

  private tick = (): void => {
    if (!this.running) return;
    const now = performance.now();
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Clamp dt to avoid jumps after tab throttling.
    if (dt > 0.05) dt = 0.05;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const elapsed = now - this.startTime;

    // --- Track cursor stillness → idle animation. ---
    const cursorMoved =
      Math.abs(this.cursorX - this.prevCursorX) > 0.5 ||
      Math.abs(this.cursorY - this.prevCursorY) > 0.5;
    if (cursorMoved) {
      this.cursorStillMs = 0;
      this.prevCursorX = this.cursorX;
      this.prevCursorY = this.cursorY;
    } else {
      this.cursorStillMs += dt * 1000;
    }

    // --- Desired flee heading: away from cursor. ---
    let fleeX = this.x - this.cursorX;
    let fleeY = this.y - this.cursorY;
    const fleeLen = Math.hypot(fleeX, fleeY) || 1;
    fleeX /= fleeLen;
    fleeY /= fleeLen;
    let desiredHeading = Math.atan2(fleeY, fleeX);

    // --- Corner-pin fix: tangential wall-escape. ---
    // When trapped against a wall / in a corner, redirect the desired heading to
    // slide ALONG the wall away from the cursor instead of driving into the
    // pocket. Returns null in the open field, leaving flee behavior untouched.
    const escape = escapeHeading(this.x, this.y, this.cursorX, this.cursorY, w, h, EDGE_MARGIN);
    const cornered = escape !== null;
    if (escape !== null) desiredHeading = escape;

    // --- Wander: slowly-drifting angular offset (perlin-ish). ---
    // Desperate jinks harder and faster; reduced-motion drops wander. Amplitude
    // scales mildly with difficulty. While cornered wander is damped so it can't
    // defeat the escape heading.
    if (!this.reducedMotion) {
      const wanderRate = this.wanderRate * (this.desperate ? 1.6 : 1);
      let wanderAmp = (this.desperate ? 0.85 : 0.6) * this.wanderScale;
      if (cornered) wanderAmp *= 0.25;
      this.wanderPhase += wanderRate * dt;
      const wander =
        Math.sin(this.wanderPhase) * 0.5 +
        Math.sin(this.wanderPhase * 2.3 + 1.7) * 0.25;
      desiredHeading += wander * wanderAmp;
    }

    // --- Steer heading toward desired (shortest angular path). ---
    // Boost steering while cornered so the sprite whips along the wall instead
    // of drifting into the pocket.
    let diff = desiredHeading - this.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const steerRate = cornered ? this.steerRate * 1.5 : this.steerRate;
    const steer = Math.min(steerRate * dt, 1);
    this.heading += diff * steer;

    // --- Speed with auto-ease + hard cap. ---
    const speed = Math.min(this.baseSpeed * this.easeFactor(elapsed), this.maxSpeed);

    this.vx = Math.cos(this.heading) * speed;
    this.vy = Math.sin(this.heading) * speed;

    // --- Soft edge-repulsion (accel that grows near edges). ---
    this.vx += this.edgeForce(this.x, w) * dt;
    this.vy += this.edgeForce(this.y, h) * dt;

    // Re-cap combined speed.
    const vlen = Math.hypot(this.vx, this.vy);
    if (vlen > this.maxSpeed) {
      this.vx = (this.vx / vlen) * this.maxSpeed;
      this.vy = (this.vy / vlen) * this.maxSpeed;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Hard clamp as a backstop; keep sprite fully on-screen.
    const pad = HIT_RADIUS * 0.6;
    const clampX = this.x < pad || this.x > w - pad;
    const clampY = this.y < pad || this.y > h - pad;
    if (clampX && clampY) {
      // Corner clamp: don't rebuild heading per-axis (that preserves the OTHER
      // axis' corner-pointing component and re-pins the sprite). Instead aim at
      // the inward quadrant diagonal — away from both walls at once.
      this.x = Math.min(w - pad, Math.max(pad, this.x));
      this.y = Math.min(h - pad, Math.max(pad, this.y));
      const inX = this.x <= pad ? 1 : -1; // inward horizontal direction
      const inY = this.y <= pad ? 1 : -1; // inward vertical direction
      this.heading = Math.atan2(inY, inX);
    } else {
      if (this.x < pad) {
        this.x = pad;
        this.heading = Math.atan2(this.vy, Math.abs(this.vx));
      } else if (this.x > w - pad) {
        this.x = w - pad;
        this.heading = Math.atan2(this.vy, -Math.abs(this.vx));
      }
      if (this.y < pad) {
        this.y = pad;
        this.heading = Math.atan2(Math.abs(this.vy), this.vx);
      } else if (this.y > h - pad) {
        this.y = h - pad;
        this.heading = Math.atan2(-Math.abs(this.vy), this.vx);
      }
    }

    // --- Sprite: walk vs idle by whether the cursor is actively chasing, and
    // face the current travel vector. When the cursor is still for a beat the
    // guardian settles into 'idle' (no in-place walking); otherwise it walks and
    // its facing row follows velocity. ---
    const movingFast = vlen > IDLE_SPEED_EPSILON;
    const shouldWalk = movingFast && this.cursorStillMs < 400;
    if (shouldWalk !== this.walking) {
      this.walking = shouldWalk;
      this.sprite.setAnim(shouldWalk ? 'walk' : 'idle');
    }
    if (shouldWalk) {
      // Point along velocity (setDirection ignores a zero vector).
      this.sprite.setDirection(this.vx, this.vy);
    }
    this.sprite.setPosition(this.x, this.y);

    // Clear the full viewport, then paint one frame ourselves so the sprite
    // doesn't smear a trail across the canvas as it moves.
    this.ctx?.clearRect(0, 0, w, h);
    this.sprite.renderFrame();

    this.rafId = requestAnimationFrame(this.tick);
  };

  /** Repulsion acceleration for one axis; pushes inward near either edge. */
  private edgeForce(pos: number, size: number): number {
    let force = 0;
    if (pos < EDGE_MARGIN) {
      const t = 1 - pos / EDGE_MARGIN;
      force += EDGE_FORCE * t * t;
    }
    if (pos > size - EDGE_MARGIN) {
      const t = 1 - (size - pos) / EDGE_MARGIN;
      force -= EDGE_FORCE * t * t;
    }
    return force;
  }
}
