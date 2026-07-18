// Species data model + pure helpers for the Pokémon v1 fork.
//
// The species table is packaged as JSON at SPECIES_JSON_PATH and loaded at
// runtime via loadSpeciesData(). All lookups here are pure functions over an
// already-loaded SpeciesData, so they are trivially unit-testable with a
// hand-written fixture (see species-fixture.ts).

import type { SpeciesId } from './types';
import { SPECIES_JSON_PATH } from './constants';

/**
 * A single sprite sheet. Frames are laid out left-to-right (columns) and, for
 * PokémonMysteryDungeon-style sheets, top-to-bottom by facing direction (rows).
 */
export interface SheetRef {
  url: string;
  frameW: number;
  frameH: number;
  /** Number of animation frames per row (columns). */
  frames: number;
  /** Number of direction rows: 8 for PMD sheets, 1 for a flat/undirected sheet. */
  directions: number;
  /** Per-frame durations in ms; length === frames. */
  durationsMs: number[];
}

/** One evolution stage of a species line. */
export interface SpeciesStage {
  name: string;
  dex: number;
  types: string[];
  flavor: string;
  /** Lowest guardian level at which this stage is active. */
  minLevel: number;
  portraitUrl: string;
  sprites: {
    walk: SheetRef;
    idle: SheetRef;
  };
}

/** A full evolution line (e.g. charmander → charmeleon → charizard). */
export interface SpeciesLine {
  id: SpeciesId;
  /** Stages in ascending minLevel order (index 0 is the base stage). */
  stages: SpeciesStage[];
}

/** The packaged species table. */
export interface SpeciesData {
  version: 1;
  generatedAt: string;
  lines: SpeciesLine[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Find a line by id, or null if absent. */
export function lineFor(data: SpeciesData, id: SpeciesId): SpeciesLine | null {
  return data.lines.find((l) => l.id === id) ?? null;
}

/**
 * Highest stage index `i` with `stages[i].minLevel <= level`. Assumes stages are
 * ordered by ascending minLevel. Returns 0 if `level` is below every threshold
 * (the base stage is always active).
 */
export function stageIndexForLevel(line: SpeciesLine, level: number): number {
  let idx = 0;
  for (let i = 0; i < line.stages.length; i++) {
    if (line.stages[i].minLevel <= level) idx = i;
    else break;
  }
  return idx;
}

/** minLevel of stage `i`, or 0 if the index is out of range. */
export function stageMinLevel(line: SpeciesLine, i: number): number {
  return line.stages[i]?.minLevel ?? 0;
}

/**
 * minLevel of the stage AFTER the one currently active at `level`, or null when
 * the guardian is already at the final stage.
 */
export function nextEvolutionLevel(line: SpeciesLine, level: number): number | null {
  const current = stageIndexForLevel(line, level);
  const next = line.stages[current + 1];
  return next ? next.minLevel : null;
}

// ---------------------------------------------------------------------------
// Runtime loader
// ---------------------------------------------------------------------------

let cached: Promise<SpeciesData> | null = null;

/**
 * Fetch and cache the packaged species table. Works in the service worker and
 * in extension pages (both resolve the packaged URL via chrome.runtime.getURL).
 * The fetch is issued at most once per module instance.
 */
export function loadSpeciesData(): Promise<SpeciesData> {
  if (cached) return cached;
  cached = (async () => {
    const url = chrome.runtime.getURL(SPECIES_JSON_PATH);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`loadSpeciesData: HTTP ${res.status} for ${url}`);
    }
    return (await res.json()) as SpeciesData;
  })();
  return cached;
}
