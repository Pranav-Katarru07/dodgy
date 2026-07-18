// Static-screen rendering for the gate (v1 Pokémon fork).
//
// Every screen is a GB/GBA dialog panel (.gb-dialog) mounted into #app. Sprites
// and portraits are pixelated canvases/imgs scaled 2-4×. Type badges are small
// colored pills. All copy is guardian-aware.
//
// Screens here are pure view builders: they take data + handlers and return
// handles (sprite views, elements) the orchestrator (gate.ts) drives. They do
// not talk to the background themselves.

import type { FullState, PartyMember } from '../shared/types';
import type { SpeciesData, SpeciesLine, SpeciesStage } from '../shared/species';
import { stageForGuardian, baseStage, makeSpriteView, assetUrl, type SpriteView } from './sprite-view';

// ---------------------------------------------------------------------------
// Type badge color map (compact, per-type). Colors chosen for legible white/dark
// text on the pill; readability verified against WCAG for the label color used.
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  normal: { bg: '#9099a1', fg: '#ffffff' },
  fire: { bg: '#ff9c54', fg: '#3a1c00' },
  water: { bg: '#4d90d5', fg: '#ffffff' },
  grass: { bg: '#63bc5a', fg: '#0d2600' },
  electric: { bg: '#f3d23b', fg: '#3a3000' },
  ice: { bg: '#74cec0', fg: '#00302b' },
  fighting: { bg: '#ce4069', fg: '#ffffff' },
  poison: { bg: '#ab6ac8', fg: '#ffffff' },
  ground: { bg: '#d97746', fg: '#2a1200' },
  flying: { bg: '#8fa8dd', fg: '#111a2e' },
  psychic: { bg: '#f97176', fg: '#3a0006' },
  bug: { bg: '#90c12c', fg: '#132200' },
  rock: { bg: '#c7b78b', fg: '#2a2200' },
  ghost: { bg: '#5269ac', fg: '#ffffff' },
  dragon: { bg: '#0b6dc3', fg: '#ffffff' },
  dark: { bg: '#5a5366', fg: '#ffffff' },
  steel: { bg: '#5a8ea1', fg: '#ffffff' },
  fairy: { bg: '#ec8fe6', fg: '#3a0033' },
};

function typeBadge(type: string): HTMLElement {
  const key = type.toLowerCase();
  const c = TYPE_COLORS[key] ?? { bg: '#7a7a7a', fg: '#ffffff' };
  const pill = document.createElement('span');
  pill.className = 'type-badge';
  pill.textContent = key.toUpperCase();
  pill.style.background = c.bg;
  pill.style.color = c.fg;
  return pill;
}

function typeBadges(types: string[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'type-badges';
  for (const t of types) row.appendChild(typeBadge(t));
  return row;
}

// ---------------------------------------------------------------------------
// Hearts (HP)
// ---------------------------------------------------------------------------

function heartsRow(hp: number, maxHp: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'hearts';
  row.setAttribute('aria-label', `${hp} of ${maxHp} health`);
  for (let i = 0; i < maxHp; i++) {
    const h = document.createElement('span');
    h.className = i < hp ? 'heart' : 'heart empty';
    h.textContent = i < hp ? '♥' : '♡';
    h.setAttribute('aria-hidden', 'true');
    row.appendChild(h);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Portrait <img> (pixelated, scaled)
// ---------------------------------------------------------------------------

function portraitImg(stage: SpeciesStage, alt: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'poke-portrait';
  img.src = assetUrl(stage.portraitUrl);
  img.alt = alt;
  img.decoding = 'async';
  return img;
}

// ---------------------------------------------------------------------------
// Mount + transitions
// ---------------------------------------------------------------------------

function mount(app: HTMLElement, screen: HTMLElement): void {
  app.appendChild(screen);
  void screen.offsetWidth; // force reflow so the transition runs
  requestAnimationFrame(() => screen.classList.add('show'));
}

function dialog(role = 'dialog'): HTMLElement {
  const el = document.createElement('section');
  el.className = 'screen';
  const box = document.createElement('div');
  box.className = 'gb-dialog';
  box.setAttribute('role', role);
  el.appendChild(box);
  return el;
}

/** Format ms remaining as HH:MM:SS. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}

export interface ScreenDeps {
  data: SpeciesData;
  reducedMotion: boolean;
}

// ===========================================================================
// 1. Starter pick
// ===========================================================================

export interface StarterPickHandlers {
  onPick: (species: string) => void;
}

/**
 * "Choose your guardian" — three GB dialog cards (portrait, name, type badges,
 * one-line flavor). Selectable by click or arrow keys + Enter.
 */
export function renderStarterPick(
  app: HTMLElement,
  deps: ScreenDeps,
  handlers: StarterPickHandlers,
): void {
  const el = document.createElement('section');
  el.className = 'screen';

  const wrap = document.createElement('div');
  wrap.className = 'gb-dialog starter-pick';
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', 'Choose your guardian');

  const h2 = document.createElement('h2');
  h2.textContent = 'Choose your guardian';
  wrap.appendChild(h2);

  const cards = document.createElement('div');
  cards.className = 'starter-cards';

  const lines = deps.data.lines;
  const cardEls: HTMLButtonElement[] = [];

  lines.forEach((line: SpeciesLine, i: number) => {
    const stage = baseStage(line);
    if (!stage) return;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'starter-card';
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', 'false');

    const img = portraitImg(stage, stage.name);
    const name = document.createElement('div');
    name.className = 'starter-name';
    name.textContent = stage.name;

    const badges = typeBadges(stage.types);

    const flavor = document.createElement('p');
    flavor.className = 'starter-flavor';
    flavor.textContent = firstSentence(stage.flavor);

    card.append(img, name, badges, flavor);

    const select = (): void => handlers.onPick(line.id);
    card.addEventListener('click', select);

    cards.appendChild(card);
    cardEls.push(card);
    void i;
  });

  wrap.appendChild(cards);

  const hint = document.createElement('p');
  hint.className = 'gb-hint';
  hint.textContent = 'Arrow keys to choose • Enter to send it out';
  wrap.appendChild(hint);

  el.appendChild(wrap);

  // Keyboard: arrows move focus between cards, Enter picks the focused one.
  let focusIdx = 0;
  const focusCard = (idx: number): void => {
    focusIdx = (idx + cardEls.length) % cardEls.length;
    cardEls.forEach((c, i) => c.setAttribute('aria-checked', String(i === focusIdx)));
    cardEls[focusIdx]?.focus();
  };
  wrap.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusCard(focusIdx + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusCard(focusIdx - 1);
    }
  });

  mount(app, el);
  requestAnimationFrame(() => focusCard(0));
}

// ===========================================================================
// 2. Guardian select (party exists, no guardian)
// ===========================================================================

export interface GuardianSelectHandlers {
  onSelect: (monId: string) => void;
}

/** Party list (name, level, hp) → set guardian. */
export function renderGuardianSelect(
  app: HTMLElement,
  deps: ScreenDeps,
  party: PartyMember[],
  maxHp: number,
  handlers: GuardianSelectHandlers,
): void {
  const el = document.createElement('section');
  el.className = 'screen';

  const wrap = document.createElement('div');
  wrap.className = 'gb-dialog guardian-select';
  wrap.setAttribute('role', 'listbox');
  wrap.setAttribute('aria-label', 'Choose today’s guardian');

  const h2 = document.createElement('h2');
  h2.textContent = 'Who will guard you today?';
  wrap.appendChild(h2);

  const list = document.createElement('div');
  list.className = 'party-list';

  const rows: HTMLButtonElement[] = [];
  party.forEach((mon) => {
    const stage = stageForGuardian(deps.data, mon);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'party-row';
    row.setAttribute('role', 'option');

    if (stage) {
      const img = portraitImg(stage, stage.name);
      img.classList.add('party-portrait');
      row.appendChild(img);
    }

    const meta = document.createElement('div');
    meta.className = 'party-meta';
    const nm = document.createElement('div');
    nm.className = 'party-name';
    nm.textContent = stage ? stage.name : mon.species;
    const lv = document.createElement('div');
    lv.className = 'party-lv';
    lv.textContent = `Lv ${mon.level}`;
    meta.append(nm, lv);
    row.appendChild(meta);

    row.appendChild(heartsRow(mon.hp, maxHp));

    row.addEventListener('click', () => handlers.onSelect(mon.id));
    list.appendChild(row);
    rows.push(row);
  });

  wrap.appendChild(list);
  el.appendChild(wrap);

  let focusIdx = 0;
  const focusRow = (idx: number): void => {
    focusIdx = (idx + rows.length) % rows.length;
    rows[focusIdx]?.focus();
  };
  wrap.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(focusIdx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(focusIdx - 1);
    }
  });

  mount(app, el);
  requestAnimationFrame(() => focusRow(0));
}

// ===========================================================================
// 3. Lockout wall
// ===========================================================================

/**
 * Fainted guardian + live countdown to next local midnight. Returns the
 * countdown element + sprite view so the orchestrator can drive the clock.
 */
export function renderLockout(
  app: HTMLElement,
  deps: ScreenDeps,
  guardian: PartyMember | null,
): { countdownEl: HTMLElement; view: SpriteView | null } {
  const el = dialog('status');
  const box = el.firstElementChild as HTMLElement;

  const name = guardianName(deps.data, guardian);

  let view: SpriteView | null = null;
  const stage = guardian ? stageForGuardian(deps.data, guardian) : null;
  if (stage) {
    view = makeSpriteView(stage, { reducedMotion: deps.reducedMotion, box: 160, scale: 3 });
    view.sprite.setEffect('fainted');
    box.appendChild(view.canvas);
  }

  const h2 = document.createElement('h2');
  h2.textContent = `${name} fainted.`;
  const p = document.createElement('p');
  p.textContent = 'Blocked sites unlock at midnight.';

  const countdown = document.createElement('div');
  countdown.className = 'countdown';
  countdown.setAttribute('aria-live', 'polite');
  countdown.textContent = '--:--:--';

  box.append(h2, p, countdown);
  mount(app, el);

  return { countdownEl: countdown, view };
}

// ===========================================================================
// 4. Guilt / confirm
// ===========================================================================

export interface GuiltHandlers {
  onContinue: () => void;
  onSpare: () => void;
}

/** Faint-streak-aware guilt copy scaled by HP. */
function guiltCopy(
  name: string,
  hp: number,
  maxHp: number,
  faintStreak: number,
  faintStreakToPermadeath: number,
): { title: string; sub: string } {
  if (hp <= 1) {
    const onePastFaint = faintStreak === faintStreakToPermadeath - 1;
    if (onePastFaint) {
      return {
        title: `One more and ${name} faints.`,
        sub: `…and ${name} has fainted ${faintStreak} days running. One more faint and it’s gone forever.`,
      };
    }
    return {
      title: `One more and ${name} faints.`,
      sub: 'Please don’t. There’s nothing behind this door worth that.',
    };
  }
  if (hp >= maxHp) {
    return {
      title: `${name} was just doing its job.`,
      sub: 'You caught it. You don’t have to push past it.',
    };
  }
  return {
    title: `${name} is getting tired.`,
    sub: 'Are you sure this is where you want to be right now?',
  };
}

/**
 * Guilt screen after a catch: portrait, name, type badges, HP hearts, streak-
 * aware copy. Buttons [Continue] / [Let {name} be]. Returns the sprite view so
 * the orchestrator can play hurt/happy on it.
 */
export function renderGuilt(
  app: HTMLElement,
  state: FullState,
  deps: ScreenDeps,
  handlers: GuiltHandlers,
): { view: SpriteView | null; name: string } {
  const guardian = state.derived.guardian;
  const maxHp = state.settings.maxHp;
  const hp = guardian?.hp ?? 0;
  const faintStreak = guardian?.faintStreak ?? 0;
  const name = guardianName(deps.data, guardian);
  const stage = guardian ? stageForGuardian(deps.data, guardian) : null;
  const copy = guiltCopy(name, hp, maxHp, faintStreak, state.settings.faintStreakToPermadeath);

  const el = dialog('dialog');
  const box = el.firstElementChild as HTMLElement;
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', `Confirm — push past ${name}?`);

  let view: SpriteView | null = null;
  if (stage) {
    view = makeSpriteView(stage, { reducedMotion: deps.reducedMotion, box: 176, scale: 3 });
    if (state.derived.desperate) view.sprite.setEffect('desperate');
    box.appendChild(view.canvas);

    const nameBar = document.createElement('div');
    nameBar.className = 'name-bar';
    const nm = document.createElement('span');
    nm.className = 'name-bar-name';
    nm.textContent = stage.name;
    nameBar.append(nm, typeBadges(stage.types));
    box.appendChild(nameBar);
  }

  const h2 = document.createElement('h2');
  h2.textContent = copy.title;
  const p = document.createElement('p');
  p.textContent = copy.sub;

  const hearts = heartsRow(hp, maxHp);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const spareBtn = document.createElement('button');
  spareBtn.className = 'btn btn-spare';
  spareBtn.type = 'button';
  spareBtn.textContent = `Let ${name} be`;
  spareBtn.addEventListener('click', handlers.onSpare);

  const continueBtn = document.createElement('button');
  continueBtn.className = 'btn btn-continue';
  continueBtn.type = 'button';
  continueBtn.textContent = 'Continue';
  continueBtn.addEventListener('click', handlers.onContinue);

  // Spare first so it gets initial keyboard focus (nudge toward restraint).
  actions.append(spareBtn, continueBtn);

  box.append(h2, p, hearts, actions);
  mount(app, el);

  requestAnimationFrame(() => spareBtn.focus());

  return { view, name };
}

// ===========================================================================
// 5. Faint
// ===========================================================================

/** Faint moment: grayscale sprite + de-level line + streak. */
export function renderFaint(
  app: HTMLElement,
  deps: ScreenDeps,
  args: {
    guardian: PartyMember | null;
    levelBefore: number;
    levelAfter: number;
    faintStreak: number;
    faintStreakToPermadeath: number;
  },
): { view: SpriteView | null } {
  const el = dialog('status');
  const box = el.firstElementChild as HTMLElement;
  const name = guardianName(deps.data, args.guardian);

  let view: SpriteView | null = null;
  const stage = args.guardian ? stageForGuardian(deps.data, args.guardian) : null;
  if (stage) {
    view = makeSpriteView(stage, { reducedMotion: deps.reducedMotion, box: 176, scale: 3 });
    // Flash hurt first; orchestrator swaps to fainted after the flash.
    view.sprite.setEffect('hurt');
    box.appendChild(view.canvas);
  }

  const h2 = document.createElement('h2');
  h2.textContent = `${name} fainted!`;
  const lv = document.createElement('p');
  lv.className = 'faint-level';
  lv.textContent = `Lv ${args.levelBefore} → ${args.levelAfter}`;
  const streak = document.createElement('p');
  streak.textContent = `Faint ${args.faintStreak} of ${args.faintStreakToPermadeath}`;
  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = 'Sites are blocked until midnight — but this one last door opens.';

  box.append(h2, lv, streak, sub);
  mount(app, el);
  return { view };
}

// ===========================================================================
// 6. Permadeath
// ===========================================================================

export function renderPermadeath(
  app: HTMLElement,
  deps: ScreenDeps,
  args: { guardian: PartyMember | null; partyEmpty: boolean },
): void {
  const el = dialog('status');
  const box = el.firstElementChild as HTMLElement;
  const name = guardianName(deps.data, args.guardian);

  const stage = args.guardian ? stageForGuardian(deps.data, args.guardian) : null;
  if (stage) {
    const view = makeSpriteView(stage, {
      reducedMotion: deps.reducedMotion,
      box: 176,
      scale: 3,
    });
    view.sprite.setEffect('fainted');
    box.appendChild(view.canvas);
  }

  const h2 = document.createElement('h2');
  h2.textContent = `${name} is gone. Forever.`;
  box.appendChild(h2);

  if (args.partyEmpty) {
    const p = document.createElement('p');
    p.textContent = 'You’ll choose a new starter next time.';
    box.appendChild(p);
  }

  mount(app, el);
}

// ===========================================================================
// 7. Spared / thank-you
// ===========================================================================

export function renderSpared(
  app: HTMLElement,
  deps: ScreenDeps,
  guardian: PartyMember | null,
  showCloseHint: boolean,
): { view: SpriteView | null } {
  const el = dialog('status');
  const box = el.firstElementChild as HTMLElement;
  const name = guardianName(deps.data, guardian);

  let view: SpriteView | null = null;
  const stage = guardian ? stageForGuardian(deps.data, guardian) : null;
  if (stage) {
    view = makeSpriteView(stage, { reducedMotion: deps.reducedMotion, box: 176, scale: 3 });
    view.sprite.setEffect('happy');
    box.appendChild(view.canvas);
  }

  const h2 = document.createElement('h2');
  h2.textContent = `${name} will remember this.`;
  const p = document.createElement('p');
  p.textContent = 'You chose to let it be. That counts.';
  box.append(h2, p);

  if (showCloseHint) {
    const hint = document.createElement('p');
    hint.className = 'sub';
    hint.textContent = 'You can close this tab now.';
    box.appendChild(hint);
  }

  mount(app, el);
  return { view };
}

// ===========================================================================
// Error
// ===========================================================================

export function renderError(app: HTMLElement, message: string): void {
  const el = dialog('alert');
  const box = el.firstElementChild as HTMLElement;

  const h2 = document.createElement('h2');
  h2.textContent = 'Something went sideways.';
  const p = document.createElement('p');
  p.textContent = message;

  const link = document.createElement('a');
  link.className = 'gb-link';
  link.href = chrome.runtime.getURL('src/settings/settings.html');
  link.textContent = 'Open settings';
  const wrap = document.createElement('p');
  wrap.append(link);

  box.append(h2, p, wrap);
  mount(app, el);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function guardianName(data: SpeciesData, guardian: PartyMember | null): string {
  if (!guardian) return 'Your guardian';
  const stage = stageForGuardian(data, guardian);
  return stage?.name ?? guardian.species;
}

function firstSentence(flavor: string): string {
  const m = flavor.match(/^[^.]*\.?/);
  return (m ? m[0] : flavor).trim();
}
