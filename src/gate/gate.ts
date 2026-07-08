/**
 * Gate page entry point.
 *
 * Flow (see dodgy-PRD.md §5):
 *   load ?target → derive domain → GET_STATE
 *     inLockout          → lockout wall (countdown → revive → chase)
 *     otherwise          → chase → catch → guilt
 *                            Continue → PAY_ENTRY → hurt → granted|death
 *                            Spare    → SPARE     → happy → back|rest
 *
 * This module owns page orchestration only. Chase physics live in ./chase and
 * static-screen rendering lives in ./screens; both are consumed here.
 */
import type { FullState } from '../shared/types';
import { SpriteEngine } from '../shared/sprite-engine';
import { sendMessage } from '../shared/messages';
import { normalizeDomain } from '../shared/domains';
import { Chase } from './chase';
import {
  renderGuilt,
  renderLockout,
  renderSpared,
  renderDeath,
  renderError,
  formatCountdown,
  type ScreenSpriteDeps,
} from './screens';

const HURT_MS = 800;
const DEATH_MS = 2500;
const SPARED_MS = 1600;
const MISSES_BEFORE_FALLBACK = 3;

const prefersReducedMotion = window.matchMedia(
  '(prefers-reduced-motion: reduce)',
).matches;

/** Resolve the app root, or throw loudly if the HTML is malformed. */
function appRoot(): HTMLElement {
  const app = document.getElementById('app');
  if (!app) throw new Error('gate: #app root missing');
  return app;
}

/** Remove every child screen/canvas so the next scene starts clean. */
function clearApp(app: HTMLElement): void {
  app.replaceChildren();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Read and validate the target URL from the query string. */
function readTarget(): { target: string; domain: string } | null {
  const raw = new URLSearchParams(location.search).get('target');
  if (!raw) return null;
  let target: string;
  try {
    // Decodes and validates; must be an http(s) URL we can navigate to.
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    target = url.href;
  } catch {
    return null;
  }
  const domain = normalizeDomain(target);
  if (!domain) return null;
  return { target, domain };
}

async function main(): Promise<void> {
  const app = appRoot();

  const parsed = readTarget();
  if (!parsed) {
    renderError(
      app,
      'This page can only be opened by dodgy when it guards a site. The address was missing or invalid.',
    );
    return;
  }
  const { target, domain } = parsed;

  let manifest;
  let state: FullState;
  try {
    manifest = await SpriteEngine.loadManifest(
      chrome.runtime.getURL('sprites/manifest.json'),
    );
    state = await sendMessage({ type: 'GET_STATE' });
  } catch {
    renderError(
      app,
      "dodgy couldn't wake up just now. Try reloading, or open settings.",
    );
    return;
  }

  const deps: ScreenSpriteDeps = {
    manifest,
    tier: state.derived.evolutionTier,
    reducedMotion: prefersReducedMotion,
  };

  if (state.derived.inLockout) {
    runLockout(app, deps, state, target, domain);
    return;
  }

  runChase(app, deps, state, target, domain);
}

// --- Lockout wall ---------------------------------------------------------

function runLockout(
  app: HTMLElement,
  deps: ScreenSpriteDeps,
  state: FullState,
  target: string,
  domain: string,
): void {
  clearApp(app);
  const { countdownEl } = renderLockout(app, deps);

  const until = state.state.lockoutUntil ?? Date.now();
  let timer = 0;

  const tick = async (): Promise<void> => {
    const remaining = until - Date.now();
    if (remaining > 0) {
      countdownEl.textContent = formatCountdown(remaining);
      return;
    }
    // Time's up: re-query state. The SW revives dodgy on read past lockout.
    window.clearInterval(timer);
    countdownEl.textContent = formatCountdown(0);
    let fresh: FullState;
    try {
      fresh = await sendMessage({ type: 'GET_STATE' });
    } catch {
      // Couldn't reach the SW; leave the wall up rather than misbehave.
      return;
    }
    if (fresh.derived.inLockout) {
      // Still locked (clock skew / fresh lockout) — resume counting.
      runLockout(app, { ...deps, tier: fresh.derived.evolutionTier }, fresh, target, domain);
      return;
    }
    runChase(app, { ...deps, tier: fresh.derived.evolutionTier }, fresh, target, domain);
  };

  void tick();
  timer = window.setInterval(() => void tick(), 1000);
}

// --- Chase ----------------------------------------------------------------

function runChase(
  app: HTMLElement,
  deps: ScreenSpriteDeps,
  state: FullState,
  target: string,
  domain: string,
): void {
  clearApp(app);

  const canvas = document.createElement('canvas');
  canvas.id = 'chase-canvas';

  const ui = document.createElement('div');
  ui.className = 'chase-ui';

  const hint = document.createElement('div');
  hint.className = 'chase-hint';
  hint.innerHTML = 'Catch <b>dodgy</b> to keep going.';

  const giveUp = document.createElement('button');
  giveUp.type = 'button';
  giveUp.className = 'give-up';
  giveUp.textContent = "I can't catch dodgy";

  ui.append(hint, giveUp);
  app.append(canvas, ui);

  requestAnimationFrame(() => hint.classList.add('show'));

  const engine = new SpriteEngine(canvas, deps.manifest, {
    reducedMotion: prefersReducedMotion,
    resolveUrl: chrome.runtime.getURL,
  });

  let chase: Chase | null = null;

  const revealFallback = (): void => {
    giveUp.classList.add('show');
  };

  const toGuilt = (): void => {
    chase?.stop();
    runGuilt(app, deps, state, target, domain);
  };

  giveUp.addEventListener('click', toGuilt);
  // Tab is an explicit signal the user wants keyboard-reachable escape.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Tab') revealFallback();
  };
  window.addEventListener('keydown', onKey);

  // Load art for the current tier, then start the chase.
  void engine.load(deps.tier).then(async () => {
    await engine.setTier(deps.tier);
    chase = new Chase({
      canvas,
      engine,
      desperate: state.derived.desperate,
      reducedMotion: prefersReducedMotion,
      onCatch: () => {
        window.removeEventListener('keydown', onKey);
        toGuilt();
      },
      onMiss: (count) => {
        if (count >= MISSES_BEFORE_FALLBACK) revealFallback();
      },
    });
    chase.start();
  });
}

// --- Guilt / confirm ------------------------------------------------------

function runGuilt(
  app: HTMLElement,
  deps: ScreenSpriteDeps,
  state: FullState,
  target: string,
  domain: string,
): void {
  clearApp(app);

  let busy = false;

  const { engine } = renderGuilt(app, state, deps, {
    onContinue: () => {
      if (busy) return;
      busy = true;
      void doContinue(app, deps, engine, target, domain);
    },
    onSpare: () => {
      if (busy) return;
      busy = true;
      void doSpare(app, deps, engine, domain);
    },
  });
}

async function doContinue(
  app: HTMLElement,
  deps: ScreenSpriteDeps,
  guiltEngine: SpriteEngine,
  target: string,
  domain: string,
): Promise<void> {
  let res;
  try {
    res = await sendMessage({ type: 'PAY_ENTRY', domain });
  } catch {
    renderError(
      app,
      "dodgy couldn't take the hit just now. Try reloading, or open settings.",
    );
    return;
  }

  // Play the hit on the held guilt sprite before moving on.
  guiltEngine.setState('hurt');
  await sleep(HURT_MS);

  if (res.outcome === 'granted') {
    location.replace(target);
    return;
  }

  // Fatal blow: show the death moment, then honor the one-last-time redirect.
  clearApp(app);
  renderDeath(app, deps);
  await sleep(DEATH_MS);
  location.replace(target);
}

async function doSpare(
  app: HTMLElement,
  deps: ScreenSpriteDeps,
  guiltEngine: SpriteEngine,
  domain: string,
): Promise<void> {
  try {
    await sendMessage({ type: 'SPARE', domain });
  } catch {
    renderError(
      app,
      "dodgy couldn't hear you just now. Try reloading, or open settings.",
    );
    return;
  }

  guiltEngine.setState('happy');
  await sleep(SPARED_MS);

  if (history.length > 1) {
    history.back();
    return;
  }
  // No previous page to return to: rest here with a gentle close hint.
  clearApp(app);
  renderSpared(app, deps, false, true);
}

void main();
