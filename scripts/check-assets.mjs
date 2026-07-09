#!/usr/bin/env node
// check-assets.mjs — offline verifier for the Pokémon v1 asset tree.
//
// Runs as a `prebuild`/`predev` gate. Makes ZERO network calls: it only checks
// that `npm run assets` has already produced a well-formed asset tree so that
// `vite build` will copy a complete set of packaged assets into dist/. If the
// tree is missing or incomplete it exits 1 with a one-line instruction.
//
// Checks:
//   - public/assets/pokemon/species.json exists and parses
//   - version === 1, has 3 lines, each line has exactly 3 stages
//   - every file a stage references (portrait + walk/idle sheets) exists on disk
//
// Zero dependencies: Node >= 20 built-ins only.

import { readFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ASSET_ROOT = join(REPO_ROOT, 'public', 'assets');
const SPECIES_JSON = join(ASSET_ROOT, 'pokemon', 'species.json');

// UI-only icon portraits (not part of species.json, but must still ship).
const UI_ICON_URLS = ['assets/pokemon/0707/portrait.png'];

/** Resolve a packaged asset url (e.g. 'assets/pokemon/0004/walk.png') to disk. */
function assetPath(url) {
  return join(REPO_ROOT, 'public', url);
}

async function exists(path) {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

function bail(reason) {
  console.error(`✗ ${reason}`);
  console.error('Missing Pokémon assets. Run: npm run assets');
  process.exit(1);
}

async function main() {
  if (!(await exists(SPECIES_JSON))) {
    bail(`species.json not found at ${SPECIES_JSON}`);
  }

  let data;
  try {
    data = JSON.parse(await readFile(SPECIES_JSON, 'utf8'));
  } catch (err) {
    bail(`species.json is not valid JSON: ${err.message}`);
  }

  if (data.version !== 1) {
    bail(`species.json version is ${data.version}, expected 1`);
  }
  if (!Array.isArray(data.lines) || data.lines.length !== 3) {
    bail(`species.json must have exactly 3 lines (found ${data.lines?.length})`);
  }

  const problems = [];

  for (const line of data.lines) {
    if (!Array.isArray(line.stages) || line.stages.length !== 3) {
      problems.push(
        `line "${line.id}" must have exactly 3 stages (found ${line.stages?.length})`,
      );
      continue;
    }
    for (const stage of line.stages) {
      const refs = [
        stage.portraitUrl,
        stage.sprites?.walk?.url,
        stage.sprites?.idle?.url,
      ];
      for (const url of refs) {
        if (!url) {
          problems.push(`${line.id}/${stage.name}: missing an asset url`);
          continue;
        }
        if (!(await exists(assetPath(url)))) {
          problems.push(`${line.id}/${stage.name}: file not found — ${url}`);
        }
      }
    }
  }

  // UI-only icons (e.g. Klefki #707 settings button) — verified by path since
  // they are intentionally absent from species.json.
  for (const url of UI_ICON_URLS) {
    if (!(await exists(assetPath(url)))) {
      problems.push(`UI icon file not found — ${url}`);
    }
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`  - ${p}`);
    bail(`${problems.length} asset problem(s) in the packaged tree`);
  }

  console.log('✓ Pokémon assets present and complete.');
}

main().catch((err) => {
  console.error('✗ Unexpected error in check-assets:', err);
  console.error('Missing Pokémon assets. Run: npm run assets');
  process.exit(1);
});
