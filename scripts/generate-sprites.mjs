// Zero-dependency sprite-sheet generator for dodgy.
//
// APPROACH (justified):
//   - Sheets are horizontal-strip PNGs (one row of frames). PNG is drawable by
//     Canvas2D `drawImage` from a chrome-extension:// URL with no CSP fuss, and
//     a single raster sheet is the preferred format per the PRD.
//   - No new deps: we hand-roll a minimal RGBA software rasterizer (filled
//     circles / ellipses / soft shapes with alpha compositing) and a tiny PNG
//     encoder that uses Node's built-in `zlib` for the IDAT deflate stream.
//     `pngjs`/`canvas` would work but are avoidable, so we avoid them.
//
// Output: public/sprites/<tier>/<state>.png  plus public/sprites/manifest.json
//
// Run with:  npm run sprites

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'public/sprites');

// ---------------------------------------------------------------------------
// Tiny RGBA canvas (straight-alpha buffer, source-over compositing).
// ---------------------------------------------------------------------------
class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4); // transparent
  }

  /** Source-over blend a straight-alpha color at integer pixel (x,y). */
  blend(x, y, r, g, b, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    const sa = a;
    const da = d[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;
    d[i] = (r * sa + d[i] * da * (1 - sa)) / outA;
    d[i + 1] = (g * sa + d[i + 1] * da * (1 - sa)) / outA;
    d[i + 2] = (b * sa + d[i + 2] * da * (1 - sa)) / outA;
    d[i + 3] = outA * 255;
  }

  /** Anti-aliased filled ellipse centered at (cx,cy) with radii (rx,ry). */
  ellipse(cx, cy, rx, ry, color) {
    const [r, g, b, alpha = 1] = color;
    const x0 = Math.floor(cx - rx - 1);
    const x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1);
    const y1 = Math.ceil(cy + ry + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // distance in normalized ellipse space, sampled for a soft 1px edge
        const nx = (x + 0.5 - cx) / rx;
        const ny = (y + 0.5 - cy) / ry;
        const d = Math.sqrt(nx * nx + ny * ny);
        // coverage: 1 inside, fades to 0 across ~1px of the smaller radius
        const feather = 1 / Math.min(rx, ry);
        const cov = clamp01((1 - d) / feather + 0.5);
        if (cov > 0) this.blend(x, y, r, g, b, alpha * cov);
      }
    }
  }

  circle(cx, cy, rad, color) {
    this.ellipse(cx, cy, rad, rad, color);
  }

  /** Filled axis-aligned rounded-ish rect via ellipse corners is overkill;
   *  a plain soft rect suffices for sweat drops / halos handled elsewhere. */
  rect(x0, y0, x1, y1, color) {
    const [r, g, b, alpha = 1] = color;
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        this.blend(x, y, r, g, b, alpha);
      }
    }
  }

  /** A teardrop: circle body + a triangle cap pointing up. Used for sweat. */
  drop(cx, cy, rad, color) {
    this.circle(cx, cy + rad * 0.3, rad, color);
    const [r, g, b, alpha = 1] = color;
    for (let y = Math.floor(cy - rad * 1.6); y < cy; y++) {
      const t = (y - (cy - rad * 1.6)) / (rad * 1.6);
      const half = rad * t;
      for (let x = Math.floor(cx - half); x < Math.ceil(cx + half); x++) {
        this.blend(x, y, r, g, b, alpha);
      }
    }
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------
// PNG encoder (RGBA, 8-bit, no interlace). IDAT via zlib deflate.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(canvas) {
  const { w, h, data } = canvas;
  // Filter each row with filter type 0 (None), prefixed per scanline.
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < w * 4; x++) {
      raw[rowStart + 1 + x] = data[y * w * 4 + x];
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Palettes per tier. Tier 1 is a visibly evolved variant: cooler violet
// palette, larger frame, plus ears — proves evolution swapping.
// ---------------------------------------------------------------------------
const TIERS = {
  0: {
    frameW: 96,
    frameH: 96,
    body: [124, 196, 132], // soft green blob
    bodyDark: [92, 168, 108],
    belly: [214, 244, 214],
    eye: [40, 52, 48],
    ears: false,
  },
  1: {
    frameW: 112,
    frameH: 112,
    body: [150, 132, 226], // evolved violet
    bodyDark: [116, 100, 196],
    belly: [226, 220, 250],
    eye: [40, 40, 60],
    ears: true, // extra feature: pointed ears / horns
  },
};

const CHEEK = [255, 170, 170, 0.55];
const SWEAT = [140, 200, 255, 0.9];
const HALO = [255, 246, 200, 0.85];

// ---------------------------------------------------------------------------
// Creature drawing. `mood` describes shape; `t` in [0,1) is anim phase.
// Returns nothing; draws one frame into `cv`.
// ---------------------------------------------------------------------------
function drawCreature(cv, pal, state, t, opts = {}) {
  const flat = !!opts.reducedMotion; // caller can suppress jitter
  const W = cv.w;
  const H = cv.h;
  const cx = W / 2;
  const baseR = W * 0.34;

  // Per-state motion params -------------------------------------------------
  let bob = 0; // vertical bob
  let squash = 1; // width scale
  let stretch = 1; // height scale
  let lean = 0; // horizontal skew of features
  let shakeX = 0;
  let ghost = false;
  let eyeStyle = 'open'; // open | happy | wince | wide | x
  let cheeks = false;

  const wave = Math.sin(t * Math.PI * 2);
  const wave2 = Math.sin(t * Math.PI * 4);

  switch (state) {
    case 'idle':
      bob = wave * 2;
      squash = 1 + wave * 0.02;
      stretch = 1 - wave * 0.02;
      // blink on the last ~20% of the loop
      eyeStyle = t > 0.82 ? 'happy' : 'open';
      break;
    case 'run':
      bob = Math.abs(wave) * -3;
      lean = 6 + wave * 2;
      squash = 1.05;
      stretch = 0.97;
      eyeStyle = 'open';
      break;
    case 'happy':
      bob = -Math.abs(wave) * 7;
      squash = 1 + Math.abs(wave) * 0.06;
      stretch = 1 - Math.abs(wave) * 0.04;
      eyeStyle = 'happy';
      cheeks = true;
      break;
    case 'hurt':
      shakeX = flat ? 0 : wave2 * 4;
      lean = -4;
      squash = 1.08;
      stretch = 0.9;
      eyeStyle = 'wince';
      break;
    case 'desperate':
      bob = wave2 * 2;
      shakeX = flat ? 0 : wave2 * 3;
      squash = 1 + Math.abs(wave2) * 0.05;
      eyeStyle = 'wide';
      cheeks = true;
      break;
    case 'dead':
      ghost = true;
      bob = wave * 3 - 4; // slow float upward drift
      eyeStyle = 'x';
      break;
  }

  const gAlpha = ghost ? 0.5 : 1;
  const bodyCol = tint(pal.body, gAlpha);
  const darkCol = tint(pal.bodyDark, gAlpha);
  const bellyCol = tint(pal.belly, gAlpha);
  const eyeCol = tint(ghost ? [120, 130, 150] : pal.eye, gAlpha);

  const bodyCx = cx + shakeX;
  const bodyCy = H * 0.55 + bob;
  const rx = baseR * squash;
  const ry = baseR * stretch;

  // Ground shadow (skipped for ghost) --------------------------------------
  if (!ghost) {
    cv.ellipse(cx, H * 0.86, baseR * 0.85, baseR * 0.16, [0, 0, 0, 0.14]);
  }

  // Halo for the dead ghost -------------------------------------------------
  if (ghost) {
    cv.ellipse(bodyCx, bodyCy - ry - 6, baseR * 0.5, baseR * 0.16, HALO);
  }

  // Ears / horns (tier 1) ---------------------------------------------------
  if (pal.ears) {
    const earDx = rx * 0.62;
    const earDy = ry * 0.72;
    cv.ellipse(bodyCx - earDx, bodyCy - earDy, baseR * 0.16, baseR * 0.3, darkCol);
    cv.ellipse(bodyCx + earDx, bodyCy - earDy, baseR * 0.16, baseR * 0.3, darkCol);
  }

  // Body --------------------------------------------------------------------
  cv.ellipse(bodyCx, bodyCy, rx, ry, bodyCol);
  // subtle darker underside
  cv.ellipse(bodyCx, bodyCy + ry * 0.35, rx * 0.9, ry * 0.5, darkCol);
  // belly highlight
  cv.ellipse(bodyCx, bodyCy + ry * 0.15, rx * 0.55, ry * 0.5, bellyCol);
  // re-draw top of body over belly for a clean crown
  cv.ellipse(bodyCx, bodyCy - ry * 0.2, rx * 0.94, ry * 0.6, bodyCol);

  // Cheeks ------------------------------------------------------------------
  if (cheeks && !ghost) {
    cv.ellipse(bodyCx - rx * 0.5, bodyCy + ry * 0.1, rx * 0.16, ry * 0.11, CHEEK);
    cv.ellipse(bodyCx + rx * 0.5, bodyCy + ry * 0.1, rx * 0.16, ry * 0.11, CHEEK);
  }

  // Eyes --------------------------------------------------------------------
  const eyeDx = rx * 0.34;
  const eyeDy = -ry * 0.1;
  const ex = bodyCx + lean;
  const eyeR = baseR * 0.11;
  drawEye(cv, ex - eyeDx, bodyCy + eyeDy, eyeR, eyeStyle, eyeCol, gAlpha);
  drawEye(cv, ex + eyeDx, bodyCy + eyeDy, eyeR, eyeStyle, eyeCol, gAlpha);

  // Mouth -------------------------------------------------------------------
  drawMouth(cv, ex, bodyCy + ry * 0.28, baseR, state, eyeCol);

  // Sweat drop (desperate) --------------------------------------------------
  if (state === 'desperate') {
    const sy = bodyCy - ry * 0.5 + wave2 * 2;
    cv.drop(bodyCx + rx * 0.7, sy, baseR * 0.09, SWEAT);
  }
}

function drawEye(cv, x, y, r, style, col, gAlpha) {
  switch (style) {
    case 'open':
      cv.circle(x, y, r, col);
      cv.circle(x - r * 0.3, y - r * 0.3, r * 0.35, [255, 255, 255, 0.9 * gAlpha]);
      break;
    case 'wide':
      cv.circle(x, y, r * 1.35, [255, 255, 255, 0.95 * gAlpha]);
      cv.circle(x, y, r * 0.8, col);
      break;
    case 'happy':
      // upward crescent (^) — draw arc as two rotated bars approximated by dots
      for (let a = -0.9; a <= 0.9; a += 0.08) {
        const px = x + a * r * 1.3;
        const py = y - Math.cos(a) * r * 0.5 + r * 0.3;
        cv.circle(px, py, r * 0.28, col);
      }
      break;
    case 'wince':
      // squeezed shut — flat-ish downward line
      for (let a = -0.9; a <= 0.9; a += 0.08) {
        const px = x + a * r * 1.3;
        const py = y + Math.cos(a) * r * 0.4 - r * 0.2;
        cv.circle(px, py, r * 0.26, col);
      }
      break;
    case 'x':
      for (let d = -r; d <= r; d += 0.6) {
        cv.circle(x + d, y + d, r * 0.22, col);
        cv.circle(x + d, y - d, r * 0.22, col);
      }
      break;
  }
}

function drawMouth(cv, x, y, baseR, state, col) {
  const r = baseR;
  if (state === 'happy') {
    for (let a = -1; a <= 1; a += 0.06) {
      cv.circle(x + a * r * 0.22, y + Math.cos(a * 1.4) * r * 0.06, r * 0.05, col);
    }
  } else if (state === 'hurt' || state === 'desperate') {
    // small open worried oval
    cv.ellipse(x, y, r * 0.1, r * 0.13, col);
  } else if (state === 'dead') {
    cv.ellipse(x, y, r * 0.08, r * 0.1, col);
  } else {
    // gentle short smile
    for (let a = -1; a <= 1; a += 0.08) {
      cv.circle(x + a * r * 0.16, y + Math.cos(a * 1.4) * r * 0.04, r * 0.045, col);
    }
  }
}

function tint([r, g, b], a) {
  return [r, g, b, a];
}

// ---------------------------------------------------------------------------
// State → frame count & fps table.
// ---------------------------------------------------------------------------
const STATES = {
  idle: { frames: 6, fps: 8 },
  run: { frames: 8, fps: 14 },
  happy: { frames: 6, fps: 12 },
  hurt: { frames: 4, fps: 10 },
  desperate: { frames: 8, fps: 16 },
  dead: { frames: 6, fps: 6 },
};

// ---------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------
function buildSheet(tierNum, state) {
  const pal = TIERS[tierNum];
  const { frames } = STATES[state];
  const fw = pal.frameW;
  const fh = pal.frameH;
  const sheet = new Canvas(fw * frames, fh);
  for (let f = 0; f < frames; f++) {
    const frame = new Canvas(fw, fh);
    drawCreature(frame, pal, state, f / frames);
    // blit frame into strip at column f
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const si = (y * fw + x) * 4;
        const di = (y * sheet.w + (f * fw + x)) * 4;
        sheet.data[di] = frame.data[si];
        sheet.data[di + 1] = frame.data[si + 1];
        sheet.data[di + 2] = frame.data[si + 2];
        sheet.data[di + 3] = frame.data[si + 3];
      }
    }
  }
  return { png: encodePng(sheet), fw, fh, frames };
}

function main() {
  const manifest = [];
  for (const tierNum of Object.keys(TIERS).map(Number)) {
    const dir = resolve(OUT_DIR, String(tierNum));
    mkdirSync(dir, { recursive: true });
    for (const state of Object.keys(STATES)) {
      const { png, fw, fh, frames } = buildSheet(tierNum, state);
      const rel = `sprites/${tierNum}/${state}.png`;
      writeFileSync(resolve(OUT_DIR, `${tierNum}/${state}.png`), png);
      manifest.push({
        tier: tierNum,
        state,
        sheetUrl: rel,
        frameW: fw,
        frameH: fh,
        frames,
        fps: STATES[state].fps,
      });
    }
  }
  writeFileSync(resolve(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Generated ${manifest.length} sprite sheets → ${OUT_DIR}`);
}

main();
