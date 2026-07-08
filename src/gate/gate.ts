/**
 * Gate page entry point (v1 Pokémon fork).
 *
 * On load: parse ?target, then GET_STATE + loadSpeciesData() in parallel, then
 * route by derived state:
 *   needsStarterPick   → STARTER PICK  → PICK_STARTER → "Go, {name}!" → chase
 *   needsGuardianPick  → GUARDIAN SELECT → SET_GUARDIAN → chase
 *   inLockout          → LOCKOUT WALL (countdown → chase at midnight)
 *   otherwise          → CHASE → catch → GUILT
 *                          Continue → PAY_ENTRY → granted|faint|permadeath|locked|no-guardian
 *                          Let it be → SPARE → happy → back|rest
 *
 * This module owns orchestration only. Chase physics live in ./chase, static
 * screens in ./screens, sprite/species helpers in ./sprite-view.
 */
import type { FullState, PartyMember } from '../shared/types';
import { sendMessage } from '../shared/messages';
import { loadSpeciesData, type SpeciesData } from '../shared/species';
import { PokemonSprite } from '../shared/sprite-engine';
import { Chase } from './chase';
import { parseTarget } from './target';
import { stageForGuardian, type SpriteView } from './sprite-view';
import {
  renderStarterPick,
  renderGuardianSelect,
  renderLockout,
  renderGuilt,
  renderFaint,
  renderPermadeath,
  renderSpared,
  renderError,
  formatCountdown,
  type ScreenDeps,
} from './screens';

const GRANTED_HURT_MS = 800;
const FAINT_MS = 2500;
const PERMADEATH_MS = 3000;
const SPARED_MS = 1600;
const GO_BEAT_MS = 1000;
const MISSES_BEFORE_FALLBACK = 3;

const prefersReducedMotion = window.matchMedia(
  '(prefers-reduced-motion: reduce)',
).matches;

interface Ctx {
  app: HTMLElement;
  deps: ScreenDeps;
  data: SpeciesData;
  target: string;
  domain: string;
}

function appRoot(): HTMLElement {
  const app = document.getElementById('app');
  if (!app) throw new Error('gate: #app root missing');
  return app;
}

function clearApp(app: HTMLElement): void {
  app.replaceChildren();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const app = appRoot();

  const parsed = parseTarget(location.search);
  if (!parsed) {
    renderError(
      app,
      'This page can only be opened when a guardian is watching a site. The address was missing or invalid.',
    );
    return;
  }
  const { target, domain } = parsed;

  let data: SpeciesData;
  let state: FullState;
  try {
    [state, data] = await Promise.all([
      sendMessage({ type: 'GET_STATE' }),
      loadSpeciesData(),
    ]);
  } catch {
    renderError(
      app,
      "Your guardian couldn't wake up just now. Try reloading, or open settings.",
    );
    return;
  }

  const deps: ScreenDeps = { data, reducedMotion: prefersReducedMotion };
  const ctx: Ctx = { app, deps, data, target, domain };

  route(ctx, state);
}

/** Pick the screen for the current state. */
function route(ctx: Ctx, state: FullState): void {
  const d = state.derived;
  if (d.needsStarterPick) {
    runStarterPick(ctx);
    return;
  }
  if (d.needsGuardianPick) {
    runGuardianSelect(ctx, state);
    return;
  }
  if (d.inLockout) {
    runLockout(ctx, state);
    return;
  }
  runChase(ctx, state);
}

// --- Starter pick ---------------------------------------------------------

function runStarterPick(ctx: Ctx): void {
  clearApp(ctx.app);
  let busy = false;
  renderStarterPick(ctx.app, ctx.deps, {
    onPick: (species) => {
      if (busy) return;
      busy = true;
      void pickStarter(ctx, species);
    },
  });
}

async function pickStarter(ctx: Ctx, species: string): Promise<void> {
  let res;
  try {
    res = await sendMessage({ type: 'PICK_STARTER', species });
  } catch {
    renderError(ctx.app, "Couldn't send out your starter. Try reloading, or open settings.");
    return;
  }
  if (!res.ok) {
    renderError(ctx.app, "That starter couldn't be chosen. Try reloading, or open settings.");
    return;
  }
  const state = res.state;
  const name = guardianName(ctx.data, state.derived.guardian);
  await goBeat(ctx, `Go, ${name}!`);
  runChase(ctx, state);
}

/** A brief "Go, {name}!" beat before the chase (~1s). */
async function goBeat(ctx: Ctx, text: string): Promise<void> {
  clearApp(ctx.app);
  const el = document.createElement('section');
  el.className = 'screen';
  const box = document.createElement('div');
  box.className = 'gb-dialog go-beat';
  const h2 = document.createElement('h2');
  h2.textContent = text;
  box.appendChild(h2);
  el.appendChild(box);
  ctx.app.appendChild(el);
  void el.offsetWidth;
  requestAnimationFrame(() => el.classList.add('show'));
  await sleep(GO_BEAT_MS);
}

// --- Guardian select ------------------------------------------------------

function runGuardianSelect(ctx: Ctx, state: FullState): void {
  clearApp(ctx.app);
  let busy = false;
  renderGuardianSelect(
    ctx.app,
    ctx.deps,
    state.state.party,
    state.settings.maxHp,
    {
      onSelect: (monId) => {
        if (busy) return;
        busy = true;
        void setGuardian(ctx, monId);
      },
    },
  );
}

async function setGuardian(ctx: Ctx, monId: string): Promise<void> {
  let res;
  try {
    res = await sendMessage({ type: 'SET_GUARDIAN', monId });
  } catch {
    renderError(ctx.app, "Couldn't set your guardian. Try reloading, or open settings.");
    return;
  }
  if (!res.ok) {
    renderError(ctx.app, "That guardian couldn't be set. Try reloading, or open settings.");
    return;
  }
  runChase(ctx, res.state);
}

// --- Lockout wall ---------------------------------------------------------

function runLockout(ctx: Ctx, state: FullState): void {
  clearApp(ctx.app);
  const { countdownEl, view } = renderLockout(ctx.app, ctx.deps, state.derived.guardian);

  const until = state.derived.lockoutUntil ?? Date.now();
  let timer = 0;

  const tick = async (): Promise<void> => {
    const remaining = until - Date.now();
    if (remaining > 0) {
      countdownEl.textContent = formatCountdown(remaining);
      return;
    }
    window.clearInterval(timer);
    countdownEl.textContent = formatCountdown(0);
    let fresh: FullState;
    try {
      fresh = await sendMessage({ type: 'GET_STATE' });
    } catch {
      return; // leave the wall up rather than misbehave
    }
    view?.destroy();
    route(ctx, fresh);
  };

  void tick();
  timer = window.setInterval(() => void tick(), 1000);
}

// --- Chase ----------------------------------------------------------------

function runChase(ctx: Ctx, state: FullState): void {
  clearApp(ctx.app);

  const guardian = state.derived.guardian;
  const stage = guardian ? stageForGuardian(ctx.data, guardian) : null;
  if (!guardian || !stage) {
    // No renderable guardian — fall back to selection/pick.
    route(ctx, state);
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.id = 'chase-canvas';

  const ui = document.createElement('div');
  ui.className = 'chase-ui';

  const hint = document.createElement('div');
  hint.className = 'chase-hint';
  hint.innerHTML = `Catch <b>${escapeHtml(stage.name)}</b> to keep going.`;

  const giveUp = document.createElement('button');
  giveUp.type = 'button';
  giveUp.className = 'give-up';
  giveUp.textContent = "I can't catch it";

  ui.append(hint, giveUp);
  ctx.app.append(canvas, ui);

  requestAnimationFrame(() => hint.classList.add('show'));

  const sprite = new PokemonSprite(
    canvas,
    { walk: stage.sprites.walk, idle: stage.sprites.idle },
    { reducedMotion: prefersReducedMotion, resolveUrl: chrome.runtime.getURL },
  );

  let chase: Chase | null = null;

  const revealFallback = (): void => {
    giveUp.classList.add('show');
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Tab') revealFallback();
  };
  window.addEventListener('keydown', onKey);

  const toGuilt = (): void => {
    window.removeEventListener('keydown', onKey);
    chase?.stop();
    runGuilt(ctx, state);
  };

  giveUp.addEventListener('click', toGuilt);

  void sprite.load().then(() => {
    chase = new Chase({
      canvas,
      sprite,
      desperate: state.derived.desperate,
      reducedMotion: prefersReducedMotion,
      onCatch: toGuilt,
      onMiss: (count) => {
        if (count >= MISSES_BEFORE_FALLBACK) revealFallback();
      },
    });
    chase.start();
  });
}

// --- Guilt / confirm ------------------------------------------------------

function runGuilt(ctx: Ctx, state: FullState): void {
  clearApp(ctx.app);
  let busy = false;
  const { view } = renderGuilt(ctx.app, state, ctx.deps, {
    onContinue: () => {
      if (busy) return;
      busy = true;
      void doContinue(ctx, state, view);
    },
    onSpare: () => {
      if (busy) return;
      busy = true;
      void doSpare(ctx, state, view);
    },
  });
}

async function doContinue(
  ctx: Ctx,
  state: FullState,
  view: SpriteView | null,
): Promise<void> {
  // Hold the pre-call guardian level for the faint before→after readout.
  const levelBefore = state.derived.guardian?.level ?? 0;
  const guardianBefore = state.derived.guardian;

  let res;
  try {
    res = await sendMessage({ type: 'PAY_ENTRY', domain: ctx.domain });
  } catch {
    renderError(ctx.app, "Your guardian couldn't take the hit just now. Try reloading, or open settings.");
    return;
  }

  switch (res.outcome) {
    case 'granted': {
      // Play the hit on the held guilt sprite, then honor the redirect.
      view?.sprite.setEffect('hurt');
      await sleep(GRANTED_HURT_MS);
      location.replace(ctx.target);
      return;
    }
    case 'faint': {
      view?.destroy();
      // PAY_ENTRY returns hp/faintStreak only; re-GET_STATE for the new level.
      let after = levelBefore;
      let guardianForFaint = guardianBefore;
      try {
        const fresh = await sendMessage({ type: 'GET_STATE' });
        const g = findGuardianForFaint(fresh, guardianBefore);
        if (g) {
          after = g.level;
          guardianForFaint = g;
        }
      } catch {
        /* fall back to held values */
      }
      clearApp(ctx.app);
      const faintView = renderFaint(ctx.app, ctx.deps, {
        guardian: guardianForFaint,
        levelBefore,
        levelAfter: after,
        faintStreak: res.faintStreak,
        faintStreakToPermadeath: state.settings.faintStreakToPermadeath,
      });
      // hurt flash → grayscale.
      await sleep(700);
      faintView.view?.sprite.setEffect('fainted');
      await sleep(FAINT_MS - 700);
      location.replace(ctx.target);
      return;
    }
    case 'permadeath': {
      view?.destroy();
      clearApp(ctx.app);
      renderPermadeath(ctx.app, ctx.deps, {
        guardian: guardianBefore,
        partyEmpty: res.partyEmpty,
      });
      await sleep(PERMADEATH_MS);
      location.replace(ctx.target);
      return;
    }
    case 'locked': {
      view?.destroy();
      // Re-fetch so the lockout wall shows the correct guardian/countdown.
      let fresh: FullState = state;
      try {
        fresh = await sendMessage({ type: 'GET_STATE' });
      } catch {
        /* use held state */
      }
      runLockout(ctx, fresh);
      return;
    }
    case 'no-guardian': {
      view?.destroy();
      let fresh: FullState = state;
      try {
        fresh = await sendMessage({ type: 'GET_STATE' });
      } catch {
        /* use held state */
      }
      route(ctx, fresh);
      return;
    }
  }
}

async function doSpare(
  ctx: Ctx,
  state: FullState,
  view: SpriteView | null,
): Promise<void> {
  try {
    await sendMessage({ type: 'SPARE', domain: ctx.domain });
  } catch {
    renderError(ctx.app, "Your guardian couldn't hear you just now. Try reloading, or open settings.");
    return;
  }

  view?.sprite.setEffect('happy');
  await sleep(SPARED_MS);

  if (history.length > 1) {
    view?.destroy();
    history.back();
    return;
  }
  view?.destroy();
  clearApp(ctx.app);
  renderSpared(ctx.app, ctx.deps, state.derived.guardian, true);
}

// --- helpers --------------------------------------------------------------

/**
 * Find the guardian that just fainted in fresh state. Prefer the same id; else
 * fall back to the active guardian (revive keeps the same mon guarding).
 */
function findGuardianForFaint(
  fresh: FullState,
  before: PartyMember | null,
): PartyMember | null {
  if (before) {
    const byId = fresh.state.party.find((m) => m.id === before.id);
    if (byId) return byId;
  }
  return fresh.derived.guardian ?? before;
}

function guardianName(data: SpeciesData, guardian: PartyMember | null): string {
  if (!guardian) return 'your guardian';
  const stage = stageForGuardian(data, guardian);
  return stage?.name ?? guardian.species;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

void main();
