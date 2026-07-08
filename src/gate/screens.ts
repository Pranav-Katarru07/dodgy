import type { FullState } from '../shared/types';
import type { SpriteState } from '../shared/types';
import { SpriteEngine } from '../shared/sprite-engine';

/**
 * Static-screen rendering for the gate: lockout wall, guilt/confirm, spared,
 * death, and the invalid-target error. Each builds a `.screen` panel with a
 * small held-sprite canvas driven by its own SpriteEngine instance.
 */

const SPRITE_PX = 200; // rendered held-sprite box (CSS px)

export interface ScreenSpriteDeps {
  manifest: import('../shared/types').SpriteManifestEntry[];
  tier: number;
  reducedMotion: boolean;
}

/** Build a held-sprite canvas + its engine, playing `state`. */
function makeSpriteCanvas(
  deps: ScreenSpriteDeps,
  state: SpriteState,
): { canvas: HTMLCanvasElement; engine: SpriteEngine } {
  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = SPRITE_PX * dpr;
  canvas.height = SPRITE_PX * dpr;
  canvas.style.width = `${SPRITE_PX}px`;
  canvas.style.height = `${SPRITE_PX}px`;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const engine = new SpriteEngine(canvas, deps.manifest, {
    reducedMotion: deps.reducedMotion,
    resolveUrl: chrome.runtime.getURL,
  });
  engine.setScale(1.6);
  engine.setPosition(SPRITE_PX / 2, SPRITE_PX / 2);

  // Drive rendering ourselves so we can clear the box before each frame — the
  // engine only draws, so an animated held sprite would otherwise ghost older
  // frames on top of newer ones.
  let raf = 0;
  const loop = (): void => {
    // ctx is transformed by dpr, so clear in CSS px.
    ctx?.clearRect(0, 0, SPRITE_PX, SPRITE_PX);
    engine.renderFrame();
    raf = requestAnimationFrame(loop);
  };
  // load() then play. setState begins the frame clock inside the engine.
  void engine.load(deps.tier).then(() => {
    void engine.setTier(deps.tier).then(() => {
      engine.setState(state);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    });
  });
  return { canvas, engine };
}

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

function mount(app: HTMLElement, screen: HTMLElement): void {
  app.appendChild(screen);
  // Force reflow so the transition runs.
  void screen.offsetWidth;
  requestAnimationFrame(() => screen.classList.add('show'));
}

/** Format ms remaining as HH:MM:SS. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}

// --- Guilt copy scales with HP. ---
function guiltCopy(hp: number, maxHp: number): { title: string; sub: string } {
  if (hp <= 1) {
    return {
      title: 'One more and dodgy is gone.',
      sub: 'Please don’t. There’s nothing behind this that’s worth it.',
    };
  }
  if (hp >= maxHp) {
    return {
      title: 'Really? dodgy was having fun.',
      sub: 'You caught it. You don’t have to hurt it.',
    };
  }
  return {
    title: 'dodgy is getting tired.',
    sub: 'Are you sure this is where you want to be right now?',
  };
}

export interface GuiltHandlers {
  onContinue: () => void;
  onSpare: () => void;
}

/** The guilt / confirm screen shown after a catch. */
export function renderGuilt(
  app: HTMLElement,
  state: FullState,
  deps: ScreenSpriteDeps,
  handlers: GuiltHandlers,
): { engine: SpriteEngine; el: HTMLElement } {
  const { hp, } = state.state;
  const maxHp = state.settings.maxHp;
  const desperate = state.derived.desperate;
  const copy = guiltCopy(hp, maxHp);

  const el = document.createElement('section');
  el.className = 'screen';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Confirm — do you want to hurt dodgy?');

  const { canvas, engine } = makeSpriteCanvas(
    deps,
    desperate ? 'desperate' : 'idle',
  );

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
  spareBtn.textContent = 'Let dodgy live';
  spareBtn.addEventListener('click', handlers.onSpare);

  const continueBtn = document.createElement('button');
  continueBtn.className = 'btn btn-continue';
  continueBtn.type = 'button';
  continueBtn.textContent = 'Continue';
  continueBtn.addEventListener('click', handlers.onContinue);

  // Spare first so it gets initial keyboard focus (nudge toward restraint).
  actions.append(spareBtn, continueBtn);

  el.append(canvas, h2, p, hearts, actions);
  mount(app, el);

  requestAnimationFrame(() => spareBtn.focus());

  return { engine, el };
}

/** The lockout wall. Returns a controller with the countdown label + engine. */
export function renderLockout(
  app: HTMLElement,
  deps: ScreenSpriteDeps,
): { engine: SpriteEngine; countdownEl: HTMLElement; el: HTMLElement } {
  const el = document.createElement('section');
  el.className = 'screen';
  el.setAttribute('role', 'status');

  const { canvas, engine } = makeSpriteCanvas(deps, 'dead');

  const h2 = document.createElement('h2');
  h2.textContent = 'dodgy is recovering.';
  const p = document.createElement('p');
  p.textContent = 'Rest with it. You can do the next right thing.';

  const countdown = document.createElement('div');
  countdown.className = 'countdown';
  countdown.setAttribute('aria-live', 'polite');
  countdown.textContent = '--:--:--';

  el.append(canvas, h2, p, countdown);
  mount(app, el);

  return { engine, countdownEl: countdown, el };
}

/** The spared / thank-you screen. */
export function renderSpared(
  app: HTMLElement,
  deps: ScreenSpriteDeps,
  desperate: boolean,
  showCloseHint: boolean,
): { engine: SpriteEngine; el: HTMLElement } {
  const el = document.createElement('section');
  el.className = 'screen';
  el.setAttribute('role', 'status');

  const { canvas, engine } = makeSpriteCanvas(deps, 'happy');

  const h2 = document.createElement('h2');
  h2.textContent = 'dodgy will remember this.';
  const p = document.createElement('p');
  p.textContent = 'You chose to let it live. That counts.';

  el.append(canvas, h2, p);

  if (showCloseHint) {
    const hint = document.createElement('p');
    hint.className = 'sub';
    hint.textContent = 'You can close this tab now.';
    el.append(hint);
  }
  void desperate;

  mount(app, el);
  return { engine, el };
}

/** The death moment shown before the fatal-hit redirect. */
export function renderDeath(
  app: HTMLElement,
  deps: ScreenSpriteDeps,
): { engine: SpriteEngine; el: HTMLElement } {
  const el = document.createElement('section');
  el.className = 'screen';
  el.setAttribute('role', 'status');

  const { canvas, engine } = makeSpriteCanvas(deps, 'dead');

  const h2 = document.createElement('h2');
  h2.textContent = 'dodgy is gone.';
  const p = document.createElement('p');
  p.textContent = 'The lockout has begun. This site still opens, one last time.';

  el.append(canvas, h2, p);
  mount(app, el);
  return { engine, el };
}

/** Friendly error for a missing/invalid target param. */
export function renderError(app: HTMLElement, message: string): void {
  const el = document.createElement('section');
  el.className = 'screen';
  el.setAttribute('role', 'alert');

  const h2 = document.createElement('h2');
  h2.textContent = 'Something went sideways.';
  const p = document.createElement('p');
  p.textContent = message;

  const link = document.createElement('a');
  link.className = 'link';
  link.href = chrome.runtime.getURL('src/settings/settings.html');
  link.textContent = 'Open dodgy settings';

  const wrap = document.createElement('p');
  wrap.append(link);

  el.append(h2, p, wrap);
  mount(app, el);
}
