import {
  lineFor,
  stageIndexForLevel,
  stageMinLevel,
  nextEvolutionLevel,
} from './species';
import type { SpeciesLine } from './species';
import { SPECIES_FIXTURE } from './species-fixture';

function line(id: string): SpeciesLine {
  const l = lineFor(SPECIES_FIXTURE, id);
  if (!l) throw new Error(`fixture missing line ${id}`);
  return l;
}

const charmander = line('charmander');
const bulbasaur = line('bulbasaur');

describe('lineFor', () => {
  it('finds a known line', () => {
    expect(lineFor(SPECIES_FIXTURE, 'squirtle')?.id).toBe('squirtle');
  });

  it('returns null for an unknown id', () => {
    expect(lineFor(SPECIES_FIXTURE, 'missingno')).toBeNull();
  });
});

describe('stageIndexForLevel — charmander (minLevels 1/16/36)', () => {
  it('stays on the base stage below the first threshold', () => {
    // Level 1 is exactly the base minLevel; nothing lower is used, but check 1.
    expect(stageIndexForLevel(charmander, 1)).toBe(0);
  });

  it('is stage 0 just below the second threshold', () => {
    expect(stageIndexForLevel(charmander, 15)).toBe(0);
  });

  it('advances to stage 1 exactly at the second threshold', () => {
    expect(stageIndexForLevel(charmander, 16)).toBe(1);
  });

  it('is stage 1 just below the final threshold', () => {
    expect(stageIndexForLevel(charmander, 35)).toBe(1);
  });

  it('advances to stage 2 exactly at the final threshold', () => {
    expect(stageIndexForLevel(charmander, 36)).toBe(2);
  });

  it('stays on the final stage above the final threshold', () => {
    expect(stageIndexForLevel(charmander, 99)).toBe(2);
  });
});

describe('stageIndexForLevel — bulbasaur (minLevels 1/16/32)', () => {
  it('is stage 1 just below the final threshold', () => {
    expect(stageIndexForLevel(bulbasaur, 31)).toBe(1);
  });

  it('advances to stage 2 exactly at the final threshold', () => {
    expect(stageIndexForLevel(bulbasaur, 32)).toBe(2);
  });
});

describe('stageMinLevel', () => {
  it('returns the minLevel of each stage', () => {
    expect(stageMinLevel(charmander, 0)).toBe(1);
    expect(stageMinLevel(charmander, 1)).toBe(16);
    expect(stageMinLevel(charmander, 2)).toBe(36);
    expect(stageMinLevel(bulbasaur, 2)).toBe(32);
  });

  it('returns 0 for an out-of-range index', () => {
    expect(stageMinLevel(charmander, 5)).toBe(0);
  });
});

describe('nextEvolutionLevel', () => {
  it('reports the next stage minLevel while below the final stage', () => {
    expect(nextEvolutionLevel(charmander, 1)).toBe(16);
    expect(nextEvolutionLevel(charmander, 15)).toBe(16);
    expect(nextEvolutionLevel(charmander, 16)).toBe(36);
    expect(nextEvolutionLevel(charmander, 35)).toBe(36);
    expect(nextEvolutionLevel(bulbasaur, 16)).toBe(32);
  });

  it('is null at the final stage', () => {
    expect(nextEvolutionLevel(charmander, 36)).toBeNull();
    expect(nextEvolutionLevel(charmander, 99)).toBeNull();
    expect(nextEvolutionLevel(bulbasaur, 32)).toBeNull();
  });
});
