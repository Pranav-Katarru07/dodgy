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
 * AUTO-EASE: after {@link EASE_START_MS} of chasing without a catch, speed eases
 * over {@link EASE_DURATION_MS} down to {@link EASE_FLOOR} of base so no one is
 * hard-stuck. Max speed is always capped.
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
}

/** Sprite hitbox radius in CSS px (generous, per spec). */
const HIT_RADIUS = 64;
/** Integer draw scale — native PMD frames are ~24-40px; 3× reads well. */
const SPRITE_SCALE = 3;

const BASE_SPEED = 320; // px/s
const DESPERATE_SPEED = 470;
const MAX_SPEED = 620; // hard cap, always
const BASE_STEER = 6.5; // steering responsiveness (1/s)
const DESPERATE_STEER = 10;

const EASE_START_MS = 30_000;
const EASE_DURATION_MS = 10_000;
const EASE_FLOOR = 0.4;

/** How far from an edge the soft-repulsion force begins (px). */
const EDGE_MARGIN = 120;
const EDGE_FORCE = 900; // px/s^2 near the very edge

/** Speed (px/s) below which the guardian is considered idle (stop walking). */
const IDLE_SPEED_EPSILON = 8;

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

    this.baseSpeed = opts.desperate ? DESPERATE_SPEED : BASE_SPEED;
    this.steerRate = opts.desperate ? DESPERATE_STEER : BASE_STEER;
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
    if (elapsedMs <= EASE_START_MS) return 1;
    const t = Math.min((elapsedMs - EASE_START_MS) / EASE_DURATION_MS, 1);
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

    // --- Wander: slowly-drifting angular offset (perlin-ish). ---
    // Desperate jinks harder and faster; reduced-motion drops wander.
    if (!this.reducedMotion) {
      const wanderRate = this.wanderRate * (this.desperate ? 1.6 : 1);
      const wanderAmp = this.desperate ? 0.85 : 0.6;
      this.wanderPhase += wanderRate * dt;
      const wander =
        Math.sin(this.wanderPhase) * 0.5 +
        Math.sin(this.wanderPhase * 2.3 + 1.7) * 0.25;
      desiredHeading += wander * wanderAmp;
    }

    // --- Steer heading toward desired (shortest angular path). ---
    let diff = desiredHeading - this.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const steer = Math.min(this.steerRate * dt, 1);
    this.heading += diff * steer;

    // --- Speed with auto-ease + hard cap. ---
    const speed = Math.min(this.baseSpeed * this.easeFactor(elapsed), MAX_SPEED);

    this.vx = Math.cos(this.heading) * speed;
    this.vy = Math.sin(this.heading) * speed;

    // --- Soft edge-repulsion (accel that grows near edges). ---
    this.vx += this.edgeForce(this.x, w) * dt;
    this.vy += this.edgeForce(this.y, h) * dt;

    // Re-cap combined speed.
    const vlen = Math.hypot(this.vx, this.vy);
    if (vlen > MAX_SPEED) {
      this.vx = (this.vx / vlen) * MAX_SPEED;
      this.vy = (this.vy / vlen) * MAX_SPEED;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Hard clamp as a backstop; keep sprite fully on-screen.
    const pad = HIT_RADIUS * 0.6;
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
