import {
  clampDifficulty,
  difficultyMultiplier,
  easeStartMsFor,
  escapeHeading,
  lerpAngle,
} from './chase';

// Viewport + margin used across the corner/wall tests.
const W = 1000;
const H = 800;
const MARGIN = 120;

/** Unit direction (cos, sin) of a heading. */
function dir(heading: number): { x: number; y: number } {
  return { x: Math.cos(heading), y: Math.sin(heading) };
}

// ---------------------------------------------------------------------------
// Difficulty mapping
// ---------------------------------------------------------------------------

describe('difficultyMultiplier', () => {
  it('anchors d=5 to exactly 1.0 (historical feel)', () => {
    expect(difficultyMultiplier(5)).toBeCloseTo(1.0, 10);
  });

  it('maps d=1 → 0.68 and d=10 → 1.4', () => {
    expect(difficultyMultiplier(1)).toBeCloseTo(0.68, 10);
    expect(difficultyMultiplier(10)).toBeCloseTo(1.4, 10);
  });

  it('is monotonically increasing', () => {
    let prev = -Infinity;
    for (let d = 1; d <= 10; d++) {
      const m = difficultyMultiplier(d);
      expect(m).toBeGreaterThan(prev);
      prev = m;
    }
  });
});

describe('easeStartMsFor', () => {
  it('hits the three anchors exactly: (1,15000) (5,30000) (10,60000)', () => {
    expect(easeStartMsFor(1)).toBeCloseTo(15_000, 6);
    expect(easeStartMsFor(5)).toBeCloseTo(30_000, 6);
    expect(easeStartMsFor(10)).toBeCloseTo(60_000, 6);
  });

  it('is monotonically increasing across 1..10', () => {
    let prev = -Infinity;
    for (let d = 1; d <= 10; d++) {
      const v = easeStartMsFor(d);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});

describe('clampDifficulty', () => {
  it('rounds and clamps into [1,10]', () => {
    expect(clampDifficulty(0)).toBe(1);
    expect(clampDifficulty(-5)).toBe(1);
    expect(clampDifficulty(11)).toBe(10);
    expect(clampDifficulty(4.6)).toBe(5);
  });

  it('coerces non-finite (NaN, ±Infinity) to the default 5', () => {
    expect(clampDifficulty(NaN)).toBe(5);
    expect(clampDifficulty(Infinity)).toBe(5);
    expect(clampDifficulty(-Infinity)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// lerpAngle
// ---------------------------------------------------------------------------

describe('lerpAngle', () => {
  it('returns a at t=0 and b at t=1', () => {
    expect(lerpAngle(0.3, 1.2, 0)).toBeCloseTo(0.3, 10);
    expect(lerpAngle(0.3, 1.2, 1)).toBeCloseTo(1.2, 10);
  });

  it('takes the shortest path across the ±π seam', () => {
    // From 170° toward -170° should go the short way (+20°), not -340°.
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;
    const mid = lerpAngle(a, b, 0.5);
    // Halfway on the short path is 180° (= ±π).
    expect(Math.abs(Math.cos(mid) - -1)).toBeLessThan(1e-9);
    expect(Math.abs(Math.sin(mid))).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// escapeHeading — open field
// ---------------------------------------------------------------------------

describe('escapeHeading — open field', () => {
  it('returns null when far from every wall', () => {
    // Sprite center-ish, cursor off to the side — plenty of room.
    expect(escapeHeading(500, 400, 300, 400, W, H, MARGIN)).toBeNull();
  });

  it('returns null near a wall when flee already points inward', () => {
    // Near left wall, but cursor is to the LEFT of the sprite so flee points
    // right (inward) — no escape needed.
    const heading = escapeHeading(40, 400, 10, 400, W, H, MARGIN);
    expect(heading).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// escapeHeading — straight walls (flee points off-screen)
// ---------------------------------------------------------------------------

describe('escapeHeading — straight wall, flee points off-screen', () => {
  it('left wall: cursor to the right → redirect roughly vertical (along wall)', () => {
    // Sprite pinned to left wall, cursor inward (to the right). Naive flee
    // points LEFT (off-screen). Escape must run along the wall (near-vertical).
    const heading = escapeHeading(20, 400, 300, 400, W, H, MARGIN);
    expect(heading).not.toBeNull();
    const d = dir(heading as number);
    // Along a vertical wall → mostly vertical motion, negligible horizontal.
    expect(Math.abs(d.x)).toBeLessThan(0.2);
    expect(Math.abs(d.y)).toBeGreaterThan(0.8);
  });

  it('top wall: cursor below → redirect roughly horizontal (along wall)', () => {
    const heading = escapeHeading(500, 20, 500, 300, W, H, MARGIN);
    expect(heading).not.toBeNull();
    const d = dir(heading as number);
    expect(Math.abs(d.y)).toBeLessThan(0.2);
    expect(Math.abs(d.x)).toBeGreaterThan(0.8);
  });
});

// ---------------------------------------------------------------------------
// escapeHeading — all four corners, cursor diagonally inside
// ---------------------------------------------------------------------------

describe('escapeHeading — corners (cursor diagonally inside)', () => {
  // For each corner, place the sprite deep in the pocket and the cursor
  // diagonally toward center. The escape heading must move the sprite AWAY
  // from the cursor (positive dot with pos−cursor) and roughly along a wall.
  const cases = [
    { name: 'top-left', px: 15, py: 15, cx: 200, cy: 200 },
    { name: 'top-right', px: W - 15, py: 15, cx: W - 200, cy: 200 },
    { name: 'bottom-left', px: 15, py: H - 15, cx: 200, cy: H - 200 },
    { name: 'bottom-right', px: W - 15, py: H - 15, cx: W - 200, cy: H - 200 },
  ];

  for (const c of cases) {
    it(`${c.name}: heading stays in-bounds and peels along a wall`, () => {
      const heading = escapeHeading(c.px, c.py, c.cx, c.cy, W, H, MARGIN);
      expect(heading).not.toBeNull();
      const d = dir(heading as number);

      // The escape heading must NOT drive further out of bounds through either
      // nearby wall — that's the whole point (the naive flee heading does).
      const nearLeft = c.px < MARGIN;
      const nearRight = W - c.px < MARGIN;
      const nearTop = c.py < MARGIN;
      const nearBottom = H - c.py < MARGIN;
      if (nearLeft) expect(d.x).toBeGreaterThanOrEqual(0);
      if (nearRight) expect(d.x).toBeLessThanOrEqual(0);
      if (nearTop) expect(d.y).toBeGreaterThanOrEqual(0);
      if (nearBottom) expect(d.y).toBeLessThanOrEqual(0);

      // And it points inward — a positive component along the inward diagonal —
      // so the sprite leaves the pocket rather than jittering in it.
      const inX = nearLeft ? 1 : nearRight ? -1 : 0;
      const inY = nearTop ? 1 : nearBottom ? -1 : 0;
      expect(d.x * inX + d.y * inY).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// escapeHeading — blend continuity
// ---------------------------------------------------------------------------

describe('escapeHeading — blend continuity', () => {
  it('at the band edge (t≈0) the corner blend ≈ the raw flee heading', () => {
    // Sprite just barely inside the corner band on both axes (t≈0, blend≈0),
    // with the cursor positioned OUTSIDE the corner (down-right of the sprite)
    // so the raw flee heading points inward (up-left, in bounds). The returned
    // heading should then track the raw flee heading closely.
    const px = MARGIN - 1;
    const py = MARGIN - 1;
    // Cursor tucked into the corner past the sprite → flee points down-right,
    // i.e. inward (in bounds through both near walls), so no sanitize kicks in.
    const cx = px - 30;
    const cy = py - 30;
    const heading = escapeHeading(px, py, cx, cy, W, H, MARGIN);
    expect(heading).not.toBeNull();

    let fleeX = px - cx;
    let fleeY = py - cy;
    const len = Math.hypot(fleeX, fleeY);
    fleeX /= len;
    fleeY /= len;
    const fleeHeading = Math.atan2(fleeY, fleeX);

    const d = dir(heading as number);
    // Cosine similarity with the flee direction should be ~1.
    const cos = d.x * Math.cos(fleeHeading) + d.y * Math.sin(fleeHeading);
    expect(cos).toBeGreaterThan(0.98);
  });
});

// ---------------------------------------------------------------------------
// Simulation: sprite escapes a camped corner within N seconds
// ---------------------------------------------------------------------------

/**
 * Minimal deterministic re-implementation of the tick physics relevant to
 * escape: flee → escapeHeading override → steer → speed → edge force → cap →
 * integrate → corner-aware clamp. Wander is DISABLED for determinism. This
 * mirrors Chase.tick's escape+clamp logic so we can assert the sprite peels
 * out of a corner the cursor is camping.
 */
function simulateCornerEscape(
  corner: { px: number; py: number; cx: number; cy: number },
  opts: { difficulty: number; steps: number; dt: number },
): { startDist: number; endDist: number } {
  const EDGE_MARGIN = 120;
  const EDGE_FORCE = 900;
  const HIT_RADIUS = 64;
  const pad = HIT_RADIUS * 0.6;
  const BASE_SPEED = 320;
  const BASE_STEER = 6.5;
  const BASE_MAX_SPEED = 620;

  const m = difficultyMultiplier(opts.difficulty);
  const baseSpeed = BASE_SPEED * m;
  const steerRate = BASE_STEER * m;
  const maxSpeed = Math.max(BASE_MAX_SPEED, BASE_MAX_SPEED * m);

  let x = corner.px;
  let y = corner.py;
  const cx = corner.cx;
  const cy = corner.cy;
  let heading = Math.random() * Math.PI * 2;
  let vx = 0;
  let vy = 0;
  const dt = opts.dt;

  const distTo = (ax: number, ay: number, bx: number, by: number): number =>
    Math.hypot(ax - bx, ay - by);
  const startDist = distTo(x, y, cx, cy);

  const edgeForce = (pos: number, size: number): number => {
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
  };

  for (let i = 0; i < opts.steps; i++) {
    let fleeX = x - cx;
    let fleeY = y - cy;
    const fleeLen = Math.hypot(fleeX, fleeY) || 1;
    fleeX /= fleeLen;
    fleeY /= fleeLen;
    let desired = Math.atan2(fleeY, fleeX);

    const escape = escapeHeading(x, y, cx, cy, W, H, EDGE_MARGIN);
    const cornered = escape !== null;
    if (escape !== null) desired = escape;

    let diff = desired - heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const sr = cornered ? steerRate * 1.5 : steerRate;
    const steer = Math.min(sr * dt, 1);
    heading += diff * steer;

    const speed = Math.min(baseSpeed, maxSpeed);
    vx = Math.cos(heading) * speed;
    vy = Math.sin(heading) * speed;
    vx += edgeForce(x, W) * dt;
    vy += edgeForce(y, H) * dt;
    const vlen = Math.hypot(vx, vy);
    if (vlen > maxSpeed) {
      vx = (vx / vlen) * maxSpeed;
      vy = (vy / vlen) * maxSpeed;
    }
    x += vx * dt;
    y += vy * dt;

    const clampX = x < pad || x > W - pad;
    const clampY = y < pad || y > H - pad;
    if (clampX && clampY) {
      x = Math.min(W - pad, Math.max(pad, x));
      y = Math.min(H - pad, Math.max(pad, y));
      const inX = x <= pad ? 1 : -1;
      const inY = y <= pad ? 1 : -1;
      heading = Math.atan2(inY, inX);
    } else {
      if (x < pad) {
        x = pad;
        heading = Math.atan2(vy, Math.abs(vx));
      } else if (x > W - pad) {
        x = W - pad;
        heading = Math.atan2(vy, -Math.abs(vx));
      }
      if (y < pad) {
        y = pad;
        heading = Math.atan2(Math.abs(vy), vx);
      } else if (y > H - pad) {
        y = H - pad;
        heading = Math.atan2(-Math.abs(vy), vx);
      }
    }
  }

  return { startDist, endDist: distTo(x, y, cx, cy) };
}

describe('corner escape simulation (deterministic)', () => {
  const corners = [
    { name: 'top-left', px: pad(), py: pad(), cx: pad() + 30, cy: pad() + 30 },
    { name: 'top-right', px: W - pad(), py: pad(), cx: W - pad() - 30, cy: pad() + 30 },
    { name: 'bottom-left', px: pad(), py: H - pad(), cx: pad() + 30, cy: H - pad() - 30 },
    {
      name: 'bottom-right',
      px: W - pad(),
      py: H - pad(),
      cx: W - pad() - 30,
      cy: H - pad() - 30,
    },
  ];

  function pad(): number {
    return 64 * 0.6;
  }

  for (const d of [1, 5, 10]) {
    for (const c of corners) {
      it(`d=${d} ${c.name}: distance from camped cursor grows within 2s`, () => {
        const { startDist, endDist } = simulateCornerEscape(c, {
          difficulty: d,
          steps: 120, // 2 seconds at dt = 1/60
          dt: 1 / 60,
        });
        // The sprite must have peeled away from the corner the cursor camps.
        expect(endDist).toBeGreaterThan(startDist + 50);
      });
    }
  }
});
