#!/usr/bin/env node
// fetch-assets.mjs — build-time asset pipeline for the Pokémon v1 fork of dodgy.
//
// Fetches ALL Pokémon data + art at build time so no Nintendo IP lives in the
// repo (the output tree public/assets/ is gitignored) and the extension makes
// ZERO runtime network calls (everything ships packaged in dist/).
//
// Sources:
//   - PokeAPI (pokeapi.co)                → flavor text, dex number, types,
//                                            evolution min-levels (validated).
//   - PokeAPI/sprites (GitHub raw)        → HGSS portrait PNGs (fallback: default).
//   - PMDCollab/SpriteCollab (GitHub raw) → walk/idle grid sheets + AnimData.xml +
//                                            per-species credits + credit_names.txt.
//   - Google Fonts (GitHub raw)           → Press Start 2P TTF + OFL license.
//
// Outputs:
//   public/assets/pokemon/{dex4}/{walk.png, idle.png, portrait.png}
//   public/assets/pokemon/species.json   (matches the frozen SpeciesData schema)
//   public/assets/pokemon/CREDITS.md
//   public/fonts/PressStart2P-Regular.ttf + public/fonts/OFL.txt (committed)
//
// Zero new dependencies: only Node >= 20 built-ins (global fetch, node:fs, etc.).
//
// Flags: --force (re-download existing files), --verbose (chatty logging).

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = join(REPO_ROOT, 'public', 'assets', 'pokemon');
const FONT_DIR = join(REPO_ROOT, 'public', 'fonts');

/**
 * PMD AnimData durations are expressed in 60fps game frames. Multiply by this to
 * get milliseconds. Named for later tuning.
 */
const DURATION_UNIT_MS = 1000 / 60;

const POKEAPI = 'https://pokeapi.co/api/v2';
const SPRITES_RAW =
  'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
const PMD_RAW =
  'https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master';

const GFONTS_RAW =
  'https://raw.githubusercontent.com/google/fonts/main/ofl/pressstart2p';

const RETRIES = 3;
const POLITE_DELAY_MS = 100;

// The 9 stages, grouped into 3 lines. `expectedMinLevels` are the in-game
// evolution thresholds and are validated against PokeAPI to guard against drift.
const LINES = [
  {
    id: 'bulbasaur',
    chain: 1,
    // bulbasaur → ivysaur (Lv16) → venusaur (Lv32)
    expectedMinLevels: [1, 16, 32],
    stages: [
      { dex: 1, name: 'Bulbasaur' },
      { dex: 2, name: 'Ivysaur' },
      { dex: 3, name: 'Venusaur' },
    ],
  },
  {
    id: 'charmander',
    chain: 2,
    // charmander → charmeleon (Lv16) → charizard (Lv36)
    expectedMinLevels: [1, 16, 36],
    stages: [
      { dex: 4, name: 'Charmander' },
      { dex: 5, name: 'Charmeleon' },
      { dex: 6, name: 'Charizard' },
    ],
  },
  {
    id: 'squirtle',
    chain: 3,
    // squirtle → wartortle (Lv16) → blastoise (Lv36)
    expectedMinLevels: [1, 16, 36],
    stages: [
      { dex: 7, name: 'Squirtle' },
      { dex: 8, name: 'Wartortle' },
      { dex: 9, name: 'Blastoise' },
    ],
  },
];

const FORCE = process.argv.includes('--force');
const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dex4 = (n) => String(n).padStart(4, '0');

function log(...args) {
  console.log(...args);
}
function vlog(...args) {
  if (VERBOSE) console.log('  ·', ...args);
}

/** Collected fatal problems; printed at the end before exit(1). */
const missing = [];

async function exists(path) {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Fetch with retries + exponential-ish backoff. Returns a Response. */
async function fetchWithRetry(url, { binary = false } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      vlog(`GET ${url}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'dodgy-asset-fetch (build script)' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      await sleep(POLITE_DELAY_MS);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) {
        const backoff = 300 * attempt;
        vlog(`retry in ${backoff}ms: ${err.message}`);
        await sleep(backoff);
      }
    }
  }
  const e = new Error(`fetch failed after ${RETRIES} tries: ${url} — ${lastErr?.message}`);
  e.url = url;
  throw e;
}

async function fetchJson(url) {
  const res = await fetchWithRetry(url);
  return res.json();
}

async function fetchText(url) {
  const res = await fetchWithRetry(url);
  return res.text();
}

async function fetchBuffer(url) {
  const res = await fetchWithRetry(url);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Try each URL in order; return the first that succeeds along with which url
 * won. Throws (aggregated) only if all fail.
 */
async function fetchBufferFallback(urls) {
  const errs = [];
  for (const url of urls) {
    try {
      const buf = await fetchBuffer(url);
      return { buf, url };
    } catch (err) {
      errs.push(err.message);
    }
  }
  throw new Error(`all fallbacks failed:\n    ${errs.join('\n    ')}`);
}

// ---------------------------------------------------------------------------
// PNG IHDR dimension reader (no image library)
// ---------------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read {width,height} from a PNG's IHDR chunk. Throws if not a valid PNG. */
function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('not a PNG (bad signature)');
  }
  // IHDR is the first chunk; its data begins at byte 16.
  // width  = bytes 16..19 big-endian, height = bytes 20..23 big-endian.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

// ---------------------------------------------------------------------------
// AnimData.xml parsing (regex/string extraction; no XML dependency)
// ---------------------------------------------------------------------------

/**
 * Extract all <Anim>…</Anim> blocks and index them by <Name>. Resolves <CopyOf>
 * indirection: an Anim whose body is `<CopyOf>Walk</CopyOf>` inherits the
 * referenced anim's FrameWidth/FrameHeight/Durations.
 *
 * Returns { name -> { frameW, frameH, durations:number[] } } for anims that
 * ultimately resolve to real frame data.
 */
function parseAnimData(xml) {
  const anims = {}; // name -> { frameW?, frameH?, durations?, copyOf? }
  const blockRe = /<Anim>([\s\S]*?)<\/Anim>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const body = m[1];
    const name = (body.match(/<Name>\s*([^<]+?)\s*<\/Name>/) || [])[1];
    if (!name) continue;
    const copyOf = (body.match(/<CopyOf>\s*([^<]+?)\s*<\/CopyOf>/) || [])[1];
    if (copyOf) {
      anims[name] = { copyOf };
      continue;
    }
    const frameW = num(body.match(/<FrameWidth>\s*(\d+)\s*<\/FrameWidth>/));
    const frameH = num(body.match(/<FrameHeight>\s*(\d+)\s*<\/FrameHeight>/));
    const durBlock = (body.match(/<Durations>([\s\S]*?)<\/Durations>/) || [])[1] || '';
    const durations = [...durBlock.matchAll(/<Duration>\s*(\d+)\s*<\/Duration>/g)].map(
      (d) => Number(d[1]),
    );
    anims[name] = { frameW, frameH, durations };
  }
  return anims;

  function num(match) {
    return match ? Number(match[1]) : undefined;
  }
}

/** Resolve a possibly-CopyOf anim to concrete frame data. */
function resolveAnim(anims, name, seen = new Set()) {
  const a = anims[name];
  if (!a) throw new Error(`AnimData has no <Anim> named "${name}"`);
  if (a.copyOf) {
    if (seen.has(name)) throw new Error(`CopyOf cycle at "${name}"`);
    seen.add(name);
    return { ...resolveAnim(anims, a.copyOf, seen), copiedFrom: a.copyOf };
  }
  if (a.frameW == null || a.frameH == null || !a.durations?.length) {
    throw new Error(`Anim "${name}" is missing frame data`);
  }
  return { frameW: a.frameW, frameH: a.frameH, durations: a.durations };
}

// ---------------------------------------------------------------------------
// Build a SheetRef for one anim (walk/idle) of one species
// ---------------------------------------------------------------------------

/**
 * Given the parsed AnimData, an anim name, and the on-disk PNG buffer, compute a
 * SheetRef {url, frameW, frameH, frames, directions, durationsMs}. Asserts the
 * PMD invariants (directions ∈ {1,8}; durations.length === frames).
 */
function buildSheetRef({ anims, animName, pngBuf, url, dexLabel }) {
  const { frameW, frameH, durations, copiedFrom } = resolveAnim(anims, animName);
  const { width: pngW, height: pngH } = pngSize(pngBuf);

  if (pngW % frameW !== 0 || pngH % frameH !== 0) {
    throw new Error(
      `${dexLabel} ${animName}: PNG ${pngW}x${pngH} not divisible by frame ${frameW}x${frameH}`,
    );
  }
  const frames = pngW / frameW;
  const directions = pngH / frameH;

  if (directions !== 1 && directions !== 8) {
    throw new Error(
      `${dexLabel} ${animName}: directions=${directions} (expected 1 or 8) [${pngW}x${pngH} / ${frameW}x${frameH}]`,
    );
  }
  if (durations.length !== frames) {
    throw new Error(
      `${dexLabel} ${animName}: durations.length=${durations.length} !== frames=${frames}`,
    );
  }

  const durationsMs = durations.map((d) => Math.round(d * DURATION_UNIT_MS));

  if (copiedFrom) {
    vlog(`${dexLabel} ${animName}: CopyOf → ${copiedFrom}`);
  }
  return { url, frameW, frameH, frames, directions, durationsMs, copiedFrom };
}

// ---------------------------------------------------------------------------
// PokeAPI data: flavor, types, dex, evolution min-levels
// ---------------------------------------------------------------------------

/** Normalize a raw flavor-text string (strip \f \n soft-hyphen, collapse ws). */
function cleanFlavor(s) {
  return s
    .replace(/\f/g, ' ')
    .replace(/­/g, '') // soft hyphen
    .replace(/[\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const FLAVOR_VERSION_PREFERENCE = [
  'heartgold',
  'soulsilver',
  'firered',
  'leafgreen',
];

/** Pick the best English flavor-text entry from a species response. */
function pickFlavor(speciesJson) {
  const en = speciesJson.flavor_text_entries.filter(
    (e) => e.language?.name === 'en',
  );
  if (en.length === 0) return '';
  for (const version of FLAVOR_VERSION_PREFERENCE) {
    const hit = en.find((e) => e.version?.name === version);
    if (hit) return cleanFlavor(hit.flavor_text);
  }
  // Fallback: newest English entry (last in the list is generally most recent).
  return cleanFlavor(en[en.length - 1].flavor_text);
}

/**
 * Walk an evolution-chain response and collect the min_level required to reach
 * each species (keyed by species name). The base species has no entry (=> 1).
 */
function collectMinLevels(chainRoot) {
  const out = {}; // speciesName -> min_level (number|null)
  function walk(node) {
    for (const child of node.evolves_to) {
      const detail = child.evolution_details?.[0] || {};
      out[child.species.name] = detail.min_level ?? null;
      walk(child);
    }
  }
  walk(chainRoot);
  return out;
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

/**
 * Parse repo-root credit_names.txt into { id -> displayName }. The file is
 * tab-separated with a header row `Name\tDiscord\tContact`; column 0 is BOTH the
 * contributor id (as referenced by per-species credits.txt) and the human name,
 * so we map each id to itself. Keeping the map lets parseSpeciesCredits tell a
 * real contributor token apart from other tab columns.
 */
function parseCreditNames(txt) {
  const map = {};
  const lines = txt.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const id = cols[0]?.trim();
    if (!id || id.toLowerCase() === 'name' || id.startsWith('#')) continue;
    map[id] = id;
  }
  return map;
}

/**
 * Parse a per-species credits.txt into an ordered, de-duped list of contributor
 * ids. Format is tab-separated lines; the contributor id(s) live in a column.
 * We heuristically collect any token that appears in credit_names or looks like
 * an id, favouring the column layout `Filename\tContributors\t...`.
 */
function parseSpeciesCredits(txt, nameMap) {
  const ids = [];
  const seen = new Set();
  const lines = txt.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    const cols = line.split('\t').map((c) => c.trim());
    // Contributor ids typically sit in column index 2 (after date + filename)
    // but layouts vary; scan all columns and keep tokens known to nameMap, or
    // that look like handles when nameMap is empty.
    for (const col of cols) {
      if (!col) continue;
      // A column may hold multiple space-separated ids.
      for (const tok of col.split(/\s+/)) {
        const id = tok.trim();
        if (!id) continue;
        const known = Object.prototype.hasOwnProperty.call(nameMap, id);
        if (known && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Font (committed, not gitignored)
// ---------------------------------------------------------------------------

async function fetchFont() {
  await mkdir(FONT_DIR, { recursive: true });
  const jobs = [
    { name: 'PressStart2P-Regular.ttf', url: `${GFONTS_RAW}/PressStart2P-Regular.ttf`, binary: true },
    { name: 'OFL.txt', url: `${GFONTS_RAW}/OFL.txt`, binary: false },
  ];
  for (const job of jobs) {
    const dest = join(FONT_DIR, job.name);
    if (!FORCE && (await exists(dest))) {
      vlog(`font ${job.name}: exists, skipping`);
      continue;
    }
    try {
      if (job.binary) {
        await writeFile(dest, await fetchBuffer(job.url));
      } else {
        await writeFile(dest, await fetchText(job.url), 'utf8');
      }
      log(`  font ${job.name} ✓`);
    } catch (err) {
      missing.push(`font ${job.name}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`dodgy asset fetch — ${FORCE ? 'force' : 'incremental'}${VERBOSE ? ', verbose' : ''}`);
  await mkdir(OUT_DIR, { recursive: true });

  // Shared: PMD credit_names.txt (once).
  let creditNames = {};
  try {
    const txt = await fetchText(`${PMD_RAW}/credit_names.txt`);
    creditNames = parseCreditNames(txt);
    vlog(`credit_names.txt: ${Object.keys(creditNames).length} known ids`);
  } catch (err) {
    missing.push(`credit_names.txt: ${err.message}`);
  }

  const linesOut = [];
  const creditsPerStage = []; // { name, dex4, contributors:[{id,name}] }

  for (const line of LINES) {
    log(`\nLine "${line.id}" (chain ${line.chain})`);

    // --- Evolution chain: validate min-levels against expectations ---
    let minLevelByName = {};
    try {
      const chainJson = await fetchJson(`${POKEAPI}/evolution-chain/${line.chain}`);
      minLevelByName = collectMinLevels(chainJson.chain);
    } catch (err) {
      missing.push(`evolution-chain/${line.chain}: ${err.message}`);
    }

    const stagesOut = [];

    for (let i = 0; i < line.stages.length; i++) {
      const stage = line.stages[i];
      const label = `#${stage.dex} ${stage.name}`;
      const d4 = dex4(stage.dex);
      const stageDir = join(OUT_DIR, d4);
      await mkdir(stageDir, { recursive: true });
      log(`  ${label}`);

      // --- validate min-level (skip base stage which is always 1) ---
      const expected = line.expectedMinLevels[i];
      let minLevel = i === 0 ? 1 : null;
      if (i > 0) {
        const apiMin = minLevelByName[stage.name.toLowerCase()];
        if (apiMin == null) {
          fail(
            `${label}: PokeAPI evolution-chain/${line.chain} has no min_level for "${stage.name.toLowerCase()}"`,
          );
        }
        if (apiMin !== expected) {
          fail(
            `${label}: PokeAPI min_level=${apiMin} != expected ${expected} (API drift — update LINES or investigate)`,
          );
        }
        minLevel = expected;
      } else if (expected !== 1) {
        fail(`${label}: base stage expected minLevel 1, config says ${expected}`);
      }

      // --- PokeAPI: flavor + types + dex ---
      let flavor = '';
      let types = [];
      let dexNum = stage.dex;
      try {
        const spJson = await fetchJson(`${POKEAPI}/pokemon-species/${stage.dex}`);
        flavor = pickFlavor(spJson);
        dexNum = spJson.id ?? stage.dex;
      } catch (err) {
        missing.push(`${label} species data: ${err.message}`);
      }
      try {
        const pkJson = await fetchJson(`${POKEAPI}/pokemon/${stage.dex}`);
        types = pkJson.types
          .sort((a, b) => a.slot - b.slot)
          .map((t) => t.type.name.toLowerCase());
      } catch (err) {
        missing.push(`${label} types: ${err.message}`);
      }

      // --- Portrait (HGSS preferred, default fallback) ---
      const portraitDest = join(stageDir, 'portrait.png');
      if (FORCE || !(await exists(portraitDest))) {
        try {
          const { buf, url } = await fetchBufferFallback([
            `${SPRITES_RAW}/versions/generation-iv/heartgold-soulsilver/${stage.dex}.png`,
            `${SPRITES_RAW}/${stage.dex}.png`,
          ]);
          await writeFile(portraitDest, buf);
          if (url.includes('heartgold-soulsilver')) vlog(`${label} portrait: HGSS`);
          else vlog(`${label} portrait: default fallback (no HGSS)`);
        } catch (err) {
          missing.push(`${label} portrait.png: ${err.message}`);
        }
      } else {
        vlog(`${label} portrait: exists`);
      }

      // --- PMD SpriteCollab: AnimData.xml + Walk/Idle sheets + credits ---
      const pmdBase = `${PMD_RAW}/sprite/${d4}`;
      let anims = null;
      try {
        const xml = await fetchText(`${pmdBase}/AnimData.xml`);
        anims = parseAnimData(xml);
      } catch (err) {
        missing.push(`${label} AnimData.xml: ${err.message}`);
      }

      const walkDest = join(stageDir, 'walk.png');
      const idleDest = join(stageDir, 'idle.png');
      let walkRef = null;
      let idleRef = null;

      // Walk sheet
      try {
        const walkBuf = await fetchBuffer(`${pmdBase}/Walk-Anim.png`);
        if (FORCE || !(await exists(walkDest))) await writeFile(walkDest, walkBuf);
        if (anims) {
          walkRef = buildSheetRef({
            anims,
            animName: 'Walk',
            pngBuf: walkBuf,
            url: `assets/pokemon/${d4}/walk.png`,
            dexLabel: label,
          });
        }
      } catch (err) {
        missing.push(`${label} walk sheet: ${err.message}`);
      }

      // Idle sheet
      try {
        const idleBuf = await fetchBuffer(`${pmdBase}/Idle-Anim.png`);
        if (FORCE || !(await exists(idleDest))) await writeFile(idleDest, idleBuf);
        if (anims) {
          idleRef = buildSheetRef({
            anims,
            animName: 'Idle',
            pngBuf: idleBuf,
            url: `assets/pokemon/${d4}/idle.png`,
            dexLabel: label,
          });
        }
      } catch (err) {
        missing.push(`${label} idle sheet: ${err.message}`);
      }

      // Per-species credits
      try {
        const credTxt = await fetchText(`${pmdBase}/credits.txt`);
        const ids = parseSpeciesCredits(credTxt, creditNames);
        creditsPerStage.push({
          name: stage.name,
          dex4: d4,
          contributors: ids.map((id) => ({ id, name: creditNames[id] || id })),
        });
      } catch (err) {
        missing.push(`${label} credits.txt: ${err.message}`);
      }

      // --- Assemble stage (strip internal `copiedFrom` note from SheetRefs) ---
      const strip = (r) =>
        r
          ? {
              url: r.url,
              frameW: r.frameW,
              frameH: r.frameH,
              frames: r.frames,
              directions: r.directions,
              durationsMs: r.durationsMs,
            }
          : null;

      stagesOut.push({
        name: stage.name,
        dex: dexNum,
        types,
        flavor,
        minLevel,
        portraitUrl: `assets/pokemon/${d4}/portrait.png`,
        sprites: { walk: strip(walkRef), idle: strip(idleRef) },
      });

      if (walkRef) {
        log(
          `    walk: ${walkRef.frames}f ${walkRef.frameW}x${walkRef.frameH} ${walkRef.directions}dir` +
            (walkRef.copiedFrom ? ` (CopyOf ${walkRef.copiedFrom})` : ''),
        );
      }
      if (idleRef) {
        log(
          `    idle: ${idleRef.frames}f ${idleRef.frameW}x${idleRef.frameH} ${idleRef.directions}dir` +
            (idleRef.copiedFrom ? ` (CopyOf ${idleRef.copiedFrom})` : ''),
        );
      }
    }

    linesOut.push({ id: line.id, stages: stagesOut });
  }

  // --- Font (committed) ---
  log('\nFont');
  await fetchFont();

  // --- Bail before writing species.json/CREDITS if anything is missing ---
  if (missing.length > 0) {
    log('\n✗ Incomplete — the following are missing (nothing already fetched was deleted):');
    for (const m of missing) log(`  - ${m}`);
    log('\nRe-run `npm run assets` to retry (existing files are skipped).');
    process.exit(1);
  }

  // --- species.json (matches frozen SpeciesData schema) ---
  const speciesData = {
    version: 1,
    generatedAt: new Date().toISOString(),
    lines: linesOut,
  };
  await writeFile(
    join(OUT_DIR, 'species.json'),
    JSON.stringify(speciesData, null, 2) + '\n',
    'utf8',
  );
  log('\nspecies.json ✓');

  // --- CREDITS.md ---
  await writeCredits(creditsPerStage);
  log('CREDITS.md ✓');

  log('\n✓ Assets fetched successfully.');
}

/** Print a fatal validation message and exit(1) immediately (drift guard). */
function fail(msg) {
  console.error(`\n✗ FATAL: ${msg}`);
  process.exit(1);
}

async function writeCredits(creditsPerStage) {
  const lines = [];
  lines.push('# Pokémon asset credits');
  lines.push('');
  lines.push(
    'This file is auto-generated by `scripts/fetch-assets.mjs` and ships in ' +
      '`dist/assets/pokemon/CREDITS.md`. It lists the artists and data sources ' +
      'behind the packaged Pokémon assets.',
  );
  lines.push('');

  lines.push('## Sprite contributors (PMD SpriteCollab)');
  lines.push('');
  for (const stage of creditsPerStage) {
    const names =
      stage.contributors.length > 0
        ? stage.contributors
            .map((c) => (c.name && c.name !== c.id ? `${c.name} (${c.id})` : c.id))
            .join(', ')
        : '(no contributor ids listed)';
    lines.push(`- **#${Number(stage.dex4)} ${stage.name}** — ${names}`);
  }
  lines.push('');

  lines.push('## Sources');
  lines.push('');
  lines.push(
    '- **Sprites (walk/idle):** PMD SpriteCollab — https://sprites.pmdcollab.org/ ' +
      '(https://github.com/PMDCollab/SpriteCollab). Individual artist credits above.',
  );
  lines.push(
    '- **Pokémon data (flavor text, types, evolution levels):** PokéAPI — https://pokeapi.co/',
  );
  lines.push(
    '- **Portraits:** PokéAPI/sprites — https://github.com/PokeAPI/sprites',
  );
  lines.push(
    '- **UI font:** Press Start 2P by CodeMan38, licensed under the SIL Open Font ' +
      'License 1.1 — https://fonts.google.com/specimen/Press+Start+2P',
  );
  lines.push('');

  lines.push('## Non-affiliation');
  lines.push('');
  lines.push(
    'This is a fan-made project. It is **not affiliated with, sponsored by, or ' +
      'endorsed by** Nintendo, Game Freak, or The Pokémon Company. Pokémon and all ' +
      'related names, characters, and imagery are the property of their respective ' +
      'owners. These assets are used for personal, non-commercial use only and are ' +
      'not distributed in this project’s source repository.',
  );
  lines.push('');

  await writeFile(join(OUT_DIR, 'CREDITS.md'), lines.join('\n'), 'utf8');
}

main().catch((err) => {
  console.error('\n✗ Unexpected error:', err);
  process.exit(1);
});
