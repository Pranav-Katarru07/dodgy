// Hand-written SpeciesData fixture with the three Gen-1 starter lines and their
// real names / types / dex numbers / evolution thresholds. Sprite refs are
// dummies (fake urls). Exported for tests ONLY — the shipped data is loaded from
// the packaged JSON via loadSpeciesData().

import type { SheetRef, SpeciesData, SpeciesStage } from './species';

function dummySheet(url: string): SheetRef {
  return {
    url,
    frameW: 32,
    frameH: 32,
    frames: 4,
    directions: 8,
    durationsMs: [166, 166, 166, 166],
  };
}

function stage(
  name: string,
  dex: number,
  types: string[],
  minLevel: number,
): SpeciesStage {
  const slug = name.toLowerCase();
  return {
    name,
    dex,
    types,
    flavor: `${name} — a Pokémon.`,
    minLevel,
    portraitUrl: `dummy/${slug}/portrait.png`,
    sprites: {
      walk: dummySheet(`dummy/${slug}/walk.png`),
      idle: dummySheet(`dummy/${slug}/idle.png`),
    },
  };
}

export const SPECIES_FIXTURE: SpeciesData = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  lines: [
    {
      id: 'charmander',
      stages: [
        stage('Charmander', 4, ['Fire'], 1),
        stage('Charmeleon', 5, ['Fire'], 16),
        stage('Charizard', 6, ['Fire', 'Flying'], 36),
      ],
    },
    {
      id: 'squirtle',
      stages: [
        stage('Squirtle', 7, ['Water'], 1),
        stage('Wartortle', 8, ['Water'], 16),
        stage('Blastoise', 9, ['Water'], 36),
      ],
    },
    {
      id: 'bulbasaur',
      stages: [
        stage('Bulbasaur', 1, ['Grass', 'Poison'], 1),
        stage('Ivysaur', 2, ['Grass', 'Poison'], 16),
        stage('Venusaur', 3, ['Grass', 'Poison'], 32),
      ],
    },
  ],
};
