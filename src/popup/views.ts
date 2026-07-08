// Pure-ish view helpers for the Dodgédex popup. These build DOM subtrees for the
// main screen, plus small formatting utilities. The controller (popup.ts) owns
// state, timers, sprite lifecycle and event wiring; this module only produces
// markup + tiny pure helpers so the pieces stay testable and readable.

import type { FullState, PartyMember } from '../shared/types';
import type { SpeciesData, SpeciesLine, SpeciesStage } from '../shared/species';
import { lineFor, stageIndexForLevel } from '../shared/species';

export type Mode = 'guardian' | 'party' | 'shop' | 'incubator';

/** Ordered stock of the egg shop (matches the three starter lines). */
export const SHOP_SPECIES: readonly string[] = ['charmander', 'squirtle', 'bulbasaur'];

/** Type-name → badge background color (standard Pokémon type palette). */
const TYPE_COLORS: Record<string, string> = {
  normal: '#9a9a7a',
  fire: '#e6702e',
  water: '#3a8fdc',
  grass: '#5fa02f',
  electric: '#e6c22e',
  ice: '#7fd0d0',
  fighting: '#b8342a',
  poison: '#8a3a9a',
  ground: '#d0a84a',
  flying: '#7a8fe0',
  psychic: '#e0487a',
  bug: '#8aa020',
  rock: '#a89030',
  ghost: '#6a4a9a',
  dragon: '#5a34d0',
  dark: '#5a4a3a',
  steel: '#8a8aa0',
  fairy: '#e0a0c0',
};

/** Approximate species accent color for eggs/ghosts (by base type). */
const SPECIES_ACCENT: Record<string, string> = {
  charmander: '#e6702e',
  squirtle: '#3a8fdc',
  bulbasaur: '#5fa02f',
};

export function typeColor(type: string): string {
  return TYPE_COLORS[type.toLowerCase()] ?? '#8a8a8a';
}

export function speciesAccent(species: string): string {
  return SPECIES_ACCENT[species.toLowerCase()] ?? '#8a8a8a';
}

/** Resolve the active stage for a party member from species data. */
export function stageForMember(
  data: SpeciesData,
  member: PartyMember,
): { line: SpeciesLine; stage: SpeciesStage; stageIndex: number } | null {
  const line = lineFor(data, member.species);
  if (!line) return null;
  const stageIndex = stageIndexForLevel(line, member.level);
  const stage = line.stages[stageIndex];
  if (!stage) return null;
  return { line, stage, stageIndex };
}

/** Base (stage 0) portrait url for a species, for shop/egg ghosts. */
export function basePortraitUrl(data: SpeciesData, species: string): string | null {
  const line = lineFor(data, species);
  return line?.stages[0]?.portraitUrl ?? null;
}

/** Base display name for a species line (used before you own one). */
export function baseName(data: SpeciesData, species: string): string {
  const line = lineFor(data, species);
  return line?.stages[0]?.name ?? species;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Evolution progress in [0,1]: how far the guardian's level has traveled from
 * the current stage's minLevel toward the next stage's minLevel. At the final
 * stage returns 1.
 */
export function evolutionProgress(
  stageMin: number,
  nextEvolutionLevel: number | null,
  level: number,
): number {
  if (nextEvolutionLevel == null) return 1;
  const span = nextEvolutionLevel - stageMin;
  if (span <= 0) return 1;
  const into = level - stageMin;
  return Math.max(0, Math.min(1, into / span));
}

// ---------------------------------------------------------------------------
// Small DOM builders
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Build the type-badge pills for the name bar. */
export function buildTypeBadges(types: string[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const t of types) {
    const b = el('span', 'type-badge', t.toUpperCase());
    b.style.background = typeColor(t);
    frag.append(b);
  }
  return frag;
}

/** HP hearts (filled/empty) as a row. */
export function buildHearts(hp: number, maxHp: number): HTMLDivElement {
  const wrap = el('div', 'hearts');
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', `${hp} of ${maxHp} HP`);
  const filled = Math.max(0, Math.min(hp, maxHp));
  for (let i = 0; i < maxHp; i++) {
    const h = el('span', i < filled ? 'h' : 'h empty', i < filled ? '♥' : '♡');
    h.setAttribute('aria-hidden', 'true');
    wrap.append(h);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Screen builders (return the content element to swap into #screen-content)
// ---------------------------------------------------------------------------

/** The empty / starter-pick prompt shown when the party is empty. */
export function buildEmptyScreen(): HTMLElement {
  return el(
    'div',
    'empty-screen',
    'No Pokémon! Visit any blocked site to choose your starter.',
  );
}

/**
 * Guardian screen. Returns the container plus the canvas so the caller can
 * attach the PokemonSprite to it. Everything except the animated canvas is
 * static markup derived from state.
 */
export function buildGuardianScreen(
  full: FullState,
  stageMin: number,
): { root: HTMLElement; canvas: HTMLCanvasElement } {
  const guardian = full.derived.guardian!;
  const root = el('div', 'guardian');

  const canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 120;
  canvas.setAttribute('aria-hidden', 'true');
  root.append(canvas);

  root.append(buildHearts(guardian.hp, full.settings.maxHp));

  const statRow = el('div', 'stat-row');
  statRow.append(el('span', undefined, `Lv ${guardian.level}`));
  const coin = el('span', 'coin', String(full.state.coins));
  statRow.append(coin);
  if (full.state.incubator) {
    statRow.append(
      el(
        'span',
        undefined,
        `Egg ${full.state.incubator.progressDays}/${full.settings.daysToHatch}`,
      ),
    );
  }
  root.append(statRow);

  const track = el('div', 'evo-track');
  const fill = el('div', 'fill');
  const pct = evolutionProgress(stageMin, full.derived.nextEvolutionLevel, guardian.level);
  fill.style.width = `${Math.round(pct * 100)}%`;
  track.append(fill);
  root.append(track);

  const caption =
    full.derived.nextEvolutionLevel == null
      ? 'final form'
      : `Lv ${full.derived.nextEvolutionLevel} to evolve`;
  root.append(el('div', 'evo-caption', caption));
  return { root, canvas };
}

/**
 * Party HGSS-style list. `selectedIndex` is the highlighted row; the left
 * viewport shows that member's portrait + meta. Returns the root.
 */
export function buildPartyScreen(
  data: SpeciesData,
  full: FullState,
  selectedIndex: number,
): HTMLElement {
  const root = el('div', 'party');
  const party = full.state.party;
  const sel = party[selectedIndex];

  // Left viewport
  const viewport = el('div', 'viewport');
  const frame = el('div', 'portrait-frame');
  if (sel) {
    const info = stageForMember(data, sel);
    if (info) {
      const img = document.createElement('img');
      img.src = chrome.runtime.getURL(info.stage.portraitUrl);
      img.alt = info.stage.name;
      frame.append(img);
    }
    viewport.append(frame);
    const meta = el(
      'div',
      'vp-meta',
      `Lv ${sel.level} · HP ${sel.hp}/${full.settings.maxHp} · faints ${sel.faintStreak}`,
    );
    viewport.append(meta);
  } else {
    viewport.append(frame);
  }
  root.append(viewport);

  // Right list
  const list = el('div', 'list');
  list.setAttribute('role', 'listbox');
  party.forEach((m, i) => {
    const info = stageForMember(data, m);
    const row = el('div', i === selectedIndex ? 'row selected' : 'row');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === selectedIndex));
    row.append(el('span', 'ball'));
    row.append(el('span', 'nm', info ? info.stage.name : m.species));
    row.append(el('span', undefined, `Lv${m.level}`));
    if (m.id === full.state.activeGuardianId) {
      row.append(el('span', 'guarding', '● GUARDING'));
    }
    list.append(row);
  });
  root.append(list);
  return root;
}

/** Egg shop with three cards; `selectedIndex` highlights one. */
export function buildShopScreen(
  data: SpeciesData,
  full: FullState,
  selectedIndex: number,
): HTMLElement {
  const root = el('div', 'shop');
  root.append(el('div', 'balance', `${full.state.coins} coins`));

  const cards = el('div', 'cards');
  const canAfford = full.state.coins >= full.settings.eggCost;
  const incubatorBusy = full.state.incubator != null;

  SHOP_SPECIES.forEach((species, i) => {
    const accent = speciesAccent(species);
    const disabled = !canAfford || incubatorBusy;
    const card = el('div', 'egg-card');
    if (i === selectedIndex) card.classList.add('selected');
    if (disabled) card.classList.add('disabled');

    // ghost portrait behind
    const ghostUrl = basePortraitUrl(data, species);
    if (ghostUrl) {
      const ghost = el('div', 'ghost');
      const gimg = document.createElement('img');
      gimg.src = chrome.runtime.getURL(ghostUrl);
      gimg.alt = '';
      ghost.append(gimg);
      card.append(ghost);
    }

    // egg shape with species-colored spots
    const egg = el('div', 'egg-shape');
    egg.style.borderColor = '#1b1b1b';
    for (const [top, left] of [
      [14, 6],
      [30, 24],
      [40, 8],
    ] as const) {
      const spot = el('div', 'spot');
      spot.style.background = accent;
      spot.style.top = `${top}px`;
      spot.style.left = `${left}px`;
      egg.append(spot);
    }
    card.append(egg);

    const name = baseName(data, species);
    card.append(el('div', 'cap', `${name}\n${full.settings.eggCost}c`));
    cards.append(card);
  });

  root.append(cards);
  return root;
}

/** Incubator screen: the egg + pips, or the empty state. */
export function buildIncubatorScreen(data: SpeciesData, full: FullState): HTMLElement {
  const root = el('div', 'incubator');
  const inc = full.state.incubator;
  if (!inc) {
    root.append(
      el('div', 'caption', 'No egg incubating.\nVisit the Egg Shop to buy one.'),
    );
    return root;
  }

  const accent = speciesAccent(inc.species);
  const egg = el('div', 'big-egg');
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (!reduce) egg.classList.add('rock');
  for (const [top, left] of [
    [22, 10],
    [46, 42],
    [64, 16],
  ] as const) {
    const spot = el('div', 'spot');
    spot.style.background = accent;
    spot.style.top = `${top}px`;
    spot.style.left = `${left}px`;
    egg.append(spot);
  }
  root.append(egg);

  const pips = el('div', 'pips');
  for (let i = 0; i < full.settings.daysToHatch; i++) {
    pips.append(el('div', i < inc.progressDays ? 'pip on' : 'pip'));
  }
  root.append(pips);

  const name = baseName(data, inc.species);
  root.append(
    el(
      'div',
      'caption',
      `${name} egg · ${inc.progressDays}/${full.settings.daysToHatch}\nhatches after clean days — messy days don't reset it`,
    ),
  );
  return root;
}

/**
 * Evolution sequence screen. Returns the root plus the container element that
 * gets `.flash` toggled by the controller (or left off under reduced motion).
 */
export function buildEvolutionScreen(
  fromStage: SpeciesStage,
  toStage: SpeciesStage,
  reducedMotion: boolean,
): { root: HTMLElement } {
  const root = el('div', 'evolution');
  if (!reducedMotion) root.classList.add('flash');

  const overlay = el('div', 'flash-overlay');
  root.append(overlay);

  const portraits = el('div', 'portraits');
  const from = document.createElement('img');
  from.src = chrome.runtime.getURL(fromStage.portraitUrl);
  from.alt = fromStage.name;
  const to = document.createElement('img');
  to.src = chrome.runtime.getURL(toStage.portraitUrl);
  to.alt = toStage.name;
  portraits.append(from, to);
  root.append(portraits);

  root.append(
    el(
      'div',
      'evo-text',
      `What? ${fromStage.name} is evolving!… ${fromStage.name} evolved into ${toStage.name}! Press ✓`,
    ),
  );
  return { root };
}
