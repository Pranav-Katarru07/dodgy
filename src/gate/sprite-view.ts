// Shared sprite/species helpers for the gate page (v1 Pokémon fork).
//
// Centralizes two things every screen needs:
//   1. resolving the SpeciesStage that a guardian should render at, and
//   2. building a self-owned, self-clearing PokemonSprite canvas for the static
//      screens (guilt / faint / permadeath / spare / lockout), so each screen
//      doesn't re-implement the load → clear-then-draw loop.
//
// The chase (chase.ts) drives its own PokemonSprite over the full viewport and
// does NOT use makeSpriteView — it owns its render loop for hit-testing.

import type { PartyMember } from '../shared/types';
import type { SpeciesData, SpeciesLine, SpeciesStage } from '../shared/species';
import { lineFor, stageIndexForLevel } from '../shared/species';
import { PokemonSprite, type PokemonSpriteSheets } from '../shared/sprite-engine';

/** Resolve the evolution line for a species id, or null when absent. */
export function lineForSpecies(
  data: SpeciesData,
  species: string,
): SpeciesLine | null {
  return lineFor(data, species);
}

/**
 * The stage a guardian renders at right now (line's stage for its level). Falls
 * back to the base stage, then null if the species is unknown.
 */
export function stageForGuardian(
  data: SpeciesData,
  guardian: PartyMember,
): SpeciesStage | null {
  const line = lineFor(data, guardian.species);
  if (!line) return null;
  const idx = stageIndexForLevel(line, guardian.level);
  return line.stages[idx] ?? line.stages[0] ?? null;
}

/** The base (stage-0) entry of a line — used for the starter-pick portraits. */
export function baseStage(line: SpeciesLine): SpeciesStage | null {
  return line.stages[0] ?? null;
}

/** Resolve a packaged asset URL through chrome.runtime.getURL. */
export function assetUrl(url: string): string {
  return chrome.runtime.getURL(url);
}

// ---------------------------------------------------------------------------
// Self-drawing sprite view for static screens
// ---------------------------------------------------------------------------

export interface SpriteView {
  canvas: HTMLCanvasElement;
  sprite: PokemonSprite;
  /** Stop the render loop and detach. Idempotent. */
  destroy(): void;
}

export interface SpriteViewOptions {
  /** CSS box size in px (square). Default 200. */
  box?: number;
  /** Integer draw scale for the native sprite frame. Default 4. */
  scale?: number;
  reducedMotion: boolean;
}

/**
 * Build a square canvas rendering `stage`'s sprite centered, with its own
 * clear-then-draw rAF loop (the engine draws but never clears). Returns handles
 * so the caller can drive setAnim/setEffect and later destroy it.
 *
 * The sprite is scaled up (pixel art is 24-40px native) with pixelated
 * rendering handled in CSS on the canvas element.
 */
export function makeSpriteView(
  stage: SpeciesStage,
  opts: SpriteViewOptions,
): SpriteView {
  const box = opts.box ?? 200;
  const scale = opts.scale ?? 4;

  const canvas = document.createElement('canvas');
  canvas.className = 'poke-canvas';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(box * dpr);
  canvas.height = Math.round(box * dpr);
  canvas.style.width = `${box}px`;
  canvas.style.height = `${box}px`;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const sheets: PokemonSpriteSheets = {
    walk: stage.sprites.walk,
    idle: stage.sprites.idle,
  };
  const sprite = new PokemonSprite(canvas, sheets, {
    reducedMotion: opts.reducedMotion,
    resolveUrl: chrome.runtime.getURL,
  });
  sprite.setScale(scale);
  sprite.setPosition(box / 2, box / 2);
  sprite.setAnim('idle');
  // Face the viewer (down row) by default for a portrait-y presentation.
  sprite.setDirection(0, 1);

  let raf = 0;
  let alive = true;
  const loop = (): void => {
    if (!alive) return;
    // ctx is dpr-transformed, so clear in CSS px.
    ctx?.clearRect(0, 0, box, box);
    sprite.renderFrame();
    raf = requestAnimationFrame(loop);
  };

  void sprite.load().then(() => {
    if (!alive) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  });

  return {
    canvas,
    sprite,
    destroy(): void {
      if (!alive) return;
      alive = false;
      cancelAnimationFrame(raf);
      sprite.stop();
    },
  };
}
