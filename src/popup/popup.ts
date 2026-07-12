// Dodgédex popup controller. Rebuilds the toolbar popup as the red Pokédex shell
// for the Pokémon v1 fork. Queries the service worker for FullState, renders one
// of four modes (Guardian / Party / Egg Shop / Incubator), plays the evolution
// sequence, and drives all interaction from either the on-screen D-pad + ✕/✓
// buttons or the keyboard (arrows / Enter / Escape).
//
// This module owns state, timers, the sprite lifecycle and event wiring; the
// pure screen builders live in views.ts.

import { sendMessage } from '../shared/messages';
import type { ActionResponse } from '../shared/messages';
import { PokemonSprite } from '../shared/sprite-engine';
import { loadSpeciesData, stageMinLevel } from '../shared/species';
import type { SpeciesData, SpeciesStage } from '../shared/species';
import type { FullState } from '../shared/types';
import {
  SHOP_SPECIES,
  buildEmptyScreen,
  buildGuardianScreen,
  buildPartyScreen,
  buildShopScreen,
  buildIncubatorScreen,
  buildEvolutionScreen,
  buildTypeBadges,
  stageForMember,
  formatCountdown,
  type Mode,
} from './views';

const STATE_REFRESH_MS = 30_000;
const COUNTDOWN_TICK_MS = 1_000;
const SPRITE_SCALE = 3;
const MODES: readonly Mode[] = ['guardian', 'party', 'shop', 'incubator'];
const MODE_LABELS: Record<Mode, string> = {
  guardian: 'GUARDIAN',
  party: 'PARTY',
  shop: 'EGG SHOP',
  incubator: 'INCUBATOR',
};

const reducedMotion =
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ---- DOM lookups (markup is fixed, so these are asserted non-null). ----
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

const shellEl = byId<HTMLDivElement>('shell');
const titleEl = byId<HTMLDivElement>('title');
const modeStripEl = byId<HTMLDivElement>('mode-strip');
const modeLabelEl = byId<HTMLSpanElement>('mode-label');
const screenContentEl = byId<HTMLDivElement>('screen-content');
const speciesNameEl = byId<HTMLSpanElement>('species-name');
const typeBadgesEl = byId<HTMLSpanElement>('type-badges');
const subScreenEl = byId<HTMLDivElement>('sub-screen');

const homeBtn = byId<HTMLButtonElement>('home-btn');
const gearBtn = byId<HTMLButtonElement>('gear-btn');
const gearIcon = byId<HTMLImageElement>('gear-icon');
const cancelBtn = byId<HTMLButtonElement>('cancel-btn');
const confirmBtn = byId<HTMLButtonElement>('confirm-btn');
const dpadUp = byId<HTMLButtonElement>('dpad-up');
const dpadDown = byId<HTMLButtonElement>('dpad-down');
const dpadLeft = byId<HTMLButtonElement>('dpad-left');
const dpadRight = byId<HTMLButtonElement>('dpad-right');

// ---- Mutable controller state ----
let speciesData: SpeciesData | undefined;
let current: FullState | undefined;
let mode: Mode = 'guardian';
/** Per-mode selection index (party rows / shop cards). */
let partyIndex = 0;
let shopIndex = 0;
/** Transient message shown on the sub-screen (e.g. "can't switch"). */
let flash: string | null = null;
/** True while the evolution sequence is on screen (blocks normal render). */
let evolving = false;

let sprite: PokemonSprite | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------------------
// LED
// ---------------------------------------------------------------------------

function ledFor(full: FullState): 'green' | 'amber' | 'red' | 'dim' {
  if (full.derived.needsStarterPick) return 'dim';
  if (full.derived.inLockout || full.derived.mood === 'fainted' || !full.derived.guardian) {
    return 'red';
  }
  if (full.derived.desperate) return 'amber';
  return 'green';
}

// ---------------------------------------------------------------------------
// Sprite lifecycle
// ---------------------------------------------------------------------------

function disposeSprite(): void {
  sprite?.stop();
  sprite = undefined;
}

/** Build + start the guardian sprite on the given canvas. */
async function mountSprite(canvas: HTMLCanvasElement, stage: SpeciesStage): Promise<void> {
  disposeSprite();
  const s = new PokemonSprite(canvas, stage.sprites, {
    reducedMotion,
    resolveUrl: chrome.runtime.getURL,
  });
  await s.load();
  s.setPosition(canvas.width / 2, canvas.height / 2);
  s.setScale(SPRITE_SCALE);
  s.setAnim('idle');
  const mood = current?.derived.mood;
  if (mood === 'fainted') s.setEffect('fainted');
  else if (mood === 'desperate') s.setEffect('desperate');
  s.start();
  sprite = s;
}

// ---------------------------------------------------------------------------
// Name bar + sub-screen
// ---------------------------------------------------------------------------

function setNameBar(name: string, types: string[]): void {
  speciesNameEl.textContent = name;
  typeBadgesEl.replaceChildren(buildTypeBadges(types));
}

function clearNameBar(): void {
  speciesNameEl.textContent = '—';
  typeBadgesEl.replaceChildren();
}

function setSubScreen(text: string): void {
  subScreenEl.textContent = text;
  subScreenEl.classList.remove('countdown');
}

function setSubScreenCountdown(text: string): void {
  subScreenEl.textContent = text;
  subScreenEl.classList.add('countdown');
}

/** Guardian-mode contextual flavor for the green sub-screen. */
function guardianFlavor(full: FullState, stageName: string): string {
  const g = full.derived.guardian;
  if (!g) return 'No guardian set.';
  const nextLvl = full.derived.nextEvolutionLevel;
  if (nextLvl == null) {
    return `${stageName} is guarding you today. It is at its final form.`;
  }
  const clean = Math.max(0, nextLvl - g.level);
  const days = clean === 1 ? 'clean day' : 'clean days';
  return `${stageName} is guarding you today. ${clean} ${days} to evolve. ${full.state.paidEntriesToday} push-throughs today · ${full.derived.coinsIfDayEndedNow} coins if you stop now.`;
}

// ---------------------------------------------------------------------------
// Mode tabs
// ---------------------------------------------------------------------------

function syncModeTabs(): void {
  shellEl.dataset.mode = mode;
  modeLabelEl.textContent = MODE_LABELS[mode];
  modeStripEl.querySelectorAll<HTMLElement>('.tab').forEach((tab) => {
    tab.setAttribute('aria-current', String(tab.dataset.mode === mode));
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(): void {
  const full = current;
  if (!full || !speciesData) return;

  titleEl.textContent = full.settings.pokedexTitle || 'Dodgédex';
  shellEl.dataset.led = ledFor(full);
  syncModeTabs();

  // Starter-pick edge state overrides everything.
  if (full.derived.needsStarterPick) {
    disposeSprite();
    screenContentEl.replaceChildren(buildEmptyScreen());
    clearNameBar();
    setSubScreen('No Pokémon yet. Visit any blocked site to pick a starter.');
    stopCountdown();
    return;
  }

  // Evolution sequence takes over the Guardian mode before the normal render.
  if (mode === 'guardian' && full.derived.guardian?.pendingEvolution) {
    renderEvolution(full);
    return;
  }
  evolving = false;

  switch (mode) {
    case 'guardian':
      renderGuardian(full);
      break;
    case 'party':
      renderParty(full);
      break;
    case 'shop':
      renderShop(full);
      break;
    case 'incubator':
      renderIncubator(full);
      break;
  }
}

function renderGuardian(full: FullState): void {
  stopCountdown();
  const guardian = full.derived.guardian;
  if (!guardian) {
    disposeSprite();
    screenContentEl.replaceChildren(buildEmptyScreen());
    clearNameBar();
    setSubScreen('No guardian set. Open the next blocked site to choose one.');
    return;
  }
  const info = stageForMember(speciesData!, guardian);
  if (!info) return;
  const stageMin = stageMinLevel(info.line, info.stageIndex);

  const { root, canvas } = buildGuardianScreen(full, stageMin);
  screenContentEl.replaceChildren(root);
  void mountSprite(canvas, info.stage);

  setNameBar(info.stage.name, info.stage.types);

  if (full.derived.inLockout && full.derived.lockoutUntil != null) {
    const remaining = full.derived.lockoutUntil - Date.now();
    setSubScreenCountdown(`${info.stage.name} fainted. Recovering… ${formatCountdown(remaining)}`);
    startCountdown();
  } else if (flash) {
    setSubScreen(flash);
  } else {
    setSubScreen(guardianFlavor(full, info.stage.name));
  }
}

function renderParty(full: FullState): void {
  stopCountdown();
  disposeSprite();
  const party = full.state.party;
  if (partyIndex >= party.length) partyIndex = Math.max(0, party.length - 1);
  screenContentEl.replaceChildren(buildPartyScreen(speciesData!, full, partyIndex));

  const sel = party[partyIndex];
  if (sel) {
    const info = stageForMember(speciesData!, sel);
    if (info) setNameBar(info.stage.name, info.stage.types);
  } else {
    clearNameBar();
  }
  if (flash) setSubScreen(flash);
  else setSubScreen('▲▼ browse party · ✓ set as today\'s guardian.');
}

function renderShop(full: FullState): void {
  stopCountdown();
  disposeSprite();
  if (shopIndex >= SHOP_SPECIES.length) shopIndex = 0;
  screenContentEl.replaceChildren(buildShopScreen(speciesData!, full, shopIndex));
  clearNameBar();

  if (flash) {
    setSubScreen(flash);
  } else if (full.state.incubator) {
    setSubScreen('The incubator is occupied. Hatch it first.');
  } else if (full.state.coins < full.settings.eggCost) {
    setSubScreen('Not enough coins. Restraint pays.');
  } else {
    setSubScreen(`▲▼ pick an egg · ✓ buy for ${full.settings.eggCost} coins.`);
  }
}

function renderIncubator(full: FullState): void {
  stopCountdown();
  disposeSprite();
  screenContentEl.replaceChildren(buildIncubatorScreen(speciesData!, full));
  clearNameBar();
  if (full.state.incubator) {
    setSubScreen('Clean days advance the egg. Messy days don\'t reset it.');
  } else {
    setSubScreen('No egg incubating. Visit the Egg Shop.');
  }
}

function renderEvolution(full: FullState): void {
  stopCountdown();
  disposeSprite();
  const guardian = full.derived.guardian!;
  const pending = guardian.pendingEvolution!;
  const info = stageForMember(speciesData!, guardian);
  if (!info) return;
  const fromStage = info.line.stages[pending.fromStage];
  const toStage = info.line.stages[pending.toStage];
  if (!fromStage || !toStage) return;

  evolving = true;
  const { root } = buildEvolutionScreen(fromStage, toStage, reducedMotion);
  screenContentEl.replaceChildren(root);
  setNameBar(toStage.name, toStage.types);
  setSubScreen(
    reducedMotion
      ? `${fromStage.name} evolved into ${toStage.name}! Press ✓.`
      : `What? ${fromStage.name} is evolving!`,
  );
}

// ---------------------------------------------------------------------------
// Countdown timer
// ---------------------------------------------------------------------------

function tickCountdown(): void {
  const full = current;
  if (!full?.derived.inLockout || full.derived.lockoutUntil == null) {
    stopCountdown();
    return;
  }
  const remaining = full.derived.lockoutUntil - Date.now();
  const name = full.derived.guardian
    ? stageForMember(speciesData!, full.derived.guardian)?.stage.name ?? 'Your Pokémon'
    : 'Your Pokémon';
  if (remaining <= 0) {
    void refresh();
    return;
  }
  if (mode === 'guardian') {
    setSubScreenCountdown(`${name} fainted. Recovering… ${formatCountdown(remaining)}`);
  }
}

function startCountdown(): void {
  if (countdownTimer !== undefined) return;
  countdownTimer = setInterval(tickCountdown, COUNTDOWN_TICK_MS);
}

function stopCountdown(): void {
  if (countdownTimer === undefined) return;
  clearInterval(countdownTimer);
  countdownTimer = undefined;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function cycleMode(dir: 1 | -1): void {
  if (evolving) return; // don't leave a pending evolution unacknowledged via nav
  flash = null;
  const i = MODES.indexOf(mode);
  mode = MODES[(i + dir + MODES.length) % MODES.length];
  render();
}

function moveSelection(dir: 1 | -1): void {
  const full = current;
  if (!full) return;
  flash = null;
  if (mode === 'party') {
    const n = full.state.party.length;
    if (n === 0) return;
    partyIndex = (partyIndex + dir + n) % n;
    renderParty(full);
  } else if (mode === 'shop') {
    const n = SHOP_SPECIES.length;
    shopIndex = (shopIndex + dir + n) % n;
    renderShop(full);
  }
}

function goHome(): void {
  if (evolving) return;
  flash = null;
  mode = 'guardian';
  render();
}

async function confirm(): Promise<void> {
  const full = current;
  if (!full) return;

  // Evolution ACK takes priority.
  if (evolving && full.derived.guardian?.pendingEvolution) {
    const resp = await sendMessage({ type: 'ACK_EVOLUTION', monId: full.derived.guardian.id });
    applyActionResponse(resp);
    return;
  }

  if (mode === 'party') {
    const sel = full.state.party[partyIndex];
    if (!sel) return;
    if (sel.id === full.state.activeGuardianId) {
      flash = `${nameOf(sel.species, sel.level)} is already guarding today.`;
      renderParty(full);
      return;
    }
    const resp = await sendMessage({ type: 'SET_GUARDIAN', monId: sel.id });
    if (!resp.ok && resp.reason === 'locked') {
      const active = full.state.party.find((m) => m.id === full.state.activeGuardianId);
      const activeName = active ? nameOf(active.species, active.level) : 'your guardian';
      flash = `Can't switch — already used ${activeName} today.`;
    }
    applyActionResponse(resp);
    return;
  }

  if (mode === 'shop') {
    const species = SHOP_SPECIES[shopIndex];
    const resp = await sendMessage({ type: 'BUY_EGG', species });
    if (!resp.ok) {
      if (resp.reason === 'insufficient-coins') flash = 'Not enough coins. Restraint pays.';
      else if (resp.reason === 'incubator-full') flash = 'The incubator is occupied.';
      else flash = 'Could not buy that egg.';
    } else {
      flash = 'Egg bought! Check the Incubator.';
    }
    applyActionResponse(resp);
    return;
  }
}

function cancel(): void {
  // Back out of a transient flash message, else return to Guardian home.
  if (flash) {
    flash = null;
    render();
    return;
  }
  goHome();
}

/** Resolve a member's display name (stage name) from species + level. */
function nameOf(species: string, level: number): string {
  if (!speciesData) return species;
  const info = stageForMember(speciesData, { species, level } as never);
  return info?.stage.name ?? species;
}

function applyActionResponse(resp: ActionResponse): void {
  current = resp.state;
  // If a successful set-guardian happened, jump back to Guardian to show it.
  render();
}

// ---------------------------------------------------------------------------
// Data + init
// ---------------------------------------------------------------------------

async function refresh(): Promise<void> {
  try {
    const full = await sendMessage({ type: 'GET_STATE' });
    current = full;
    render();
  } catch {
    if (!current) setSubScreen('Waking up the Dodgédex…');
  }
}

function onKeyDown(e: KeyboardEvent): void {
  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      cycleMode(-1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      cycleMode(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      moveSelection(-1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      moveSelection(1);
      break;
    case 'Enter':
      e.preventDefault();
      void confirm();
      break;
    case 'Escape':
      e.preventDefault();
      cancel();
      break;
    case 'Backspace':
      // Mirror the red ✕ (cancel/back). preventDefault so Backspace doesn't
      // trigger browser back/history navigation in the popup context.
      e.preventDefault();
      cancel();
      break;
  }
}

/**
 * Point the settings button at Klang's portrait (UI-only icon, dex 600). If the
 * image ever fails to load, fall back to the ⚙ glyph so the button never renders
 * empty. Mirrors the never-throw handling used for the other portraits.
 */
function setupGearIcon(): void {
  gearIcon.addEventListener('error', () => {
    gearBtn.classList.add('fallback');
    gearBtn.textContent = '⚙';
  });
  try {
    gearIcon.src = chrome.runtime.getURL('assets/pokemon/0600/portrait.png');
  } catch {
    gearBtn.classList.add('fallback');
    gearBtn.textContent = '⚙';
  }
}

async function init(): Promise<void> {
  // Wire controls.
  setupGearIcon();
  homeBtn.addEventListener('click', goHome);
  gearBtn.addEventListener('click', () => void chrome.runtime.openOptionsPage());
  confirmBtn.addEventListener('click', () => void confirm());
  cancelBtn.addEventListener('click', cancel);
  dpadUp.addEventListener('click', () => moveSelection(-1));
  dpadDown.addEventListener('click', () => moveSelection(1));
  dpadLeft.addEventListener('click', () => cycleMode(-1));
  dpadRight.addEventListener('click', () => cycleMode(1));
  modeStripEl.querySelectorAll<HTMLElement>('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const m = tab.dataset.mode as Mode | undefined;
      if (m && MODES.includes(m) && !evolving) {
        flash = null;
        mode = m;
        render();
      }
    });
  });
  document.addEventListener('keydown', onKeyDown);

  try {
    speciesData = await loadSpeciesData();
  } catch {
    // Without species data we can still show the shell + a message.
    setSubScreen('Species data unavailable.');
  }

  await refresh();
  refreshTimer = setInterval(() => void refresh(), STATE_REFRESH_MS);

  window.addEventListener('unload', () => {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    stopCountdown();
    disposeSprite();
  });
}

void init();
