// Popup: the pet's home. Queries the service worker for FullState and renders
// dodgy — animated sprite, HP hearts, level/evolution progress, today's stakes,
// and a live lockout countdown when applicable. Refreshes every 30s while open.
import { sendMessage } from '../shared/messages';
import { SpriteEngine } from '../shared/sprite-engine';
import type { FullState, SpriteState } from '../shared/types';

const STATE_REFRESH_MS = 30_000;
const COUNTDOWN_TICK_MS = 1_000;
const SPRITE_SCALE = 1.4;

// ---- DOM lookups (markup is fixed, so these are asserted non-null). ----
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

const tierBadgeEl = byId<HTMLSpanElement>('tier-badge');
const settingsBtn = byId<HTMLButtonElement>('settings-btn');
const canvasEl = byId<HTMLCanvasElement>('sprite');
const fallbackEl = byId<HTMLParagraphElement>('fallback');
const calmViewEl = byId<HTMLDivElement>('calm-view');
const heartsEl = byId<HTMLDivElement>('hearts');
const hpTextEl = byId<HTMLDivElement>('hp-text');
const levelLineEl = byId<HTMLDivElement>('level-line');
const evoFillEl = byId<HTMLDivElement>('evo-fill');
const todayEl = byId<HTMLDivElement>('today');
const lockoutViewEl = byId<HTMLDivElement>('lockout-view');
const countdownEl = byId<HTMLDivElement>('countdown');
const lockoutMsgEl = byId<HTMLDivElement>('lockout-msg');

const reducedMotion =
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

let engine: SpriteEngine | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;

/** Latest authoritative state; the countdown tick reads lockoutUntil from here. */
let current: FullState | undefined;

// ---------------------------------------------------------------------------
// Sprite
// ---------------------------------------------------------------------------

/** Map the derived mood to the sprite sheet to play in the popup. */
function spriteStateFor(mood: FullState['derived']['mood']): SpriteState {
  if (mood === 'dead') return 'dead';
  if (mood === 'desperate') return 'desperate';
  return 'idle';
}

/** Build the sprite engine once and center it on the canvas. */
async function initSprite(): Promise<void> {
  try {
    const manifest = await SpriteEngine.loadManifest(
      chrome.runtime.getURL('sprites/manifest.json'),
    );
    const eng = new SpriteEngine(canvasEl, manifest, {
      reducedMotion,
      resolveUrl: chrome.runtime.getURL,
    });
    eng.setPosition(canvasEl.width / 2, canvasEl.height / 2);
    eng.setScale(SPRITE_SCALE);
    engine = eng;
  } catch {
    // Sprite art is non-essential; the stats still render without it.
    engine = undefined;
  }
}

/** Point the sprite at the right tier + state for the given full state. */
async function updateSprite(full: FullState): Promise<void> {
  if (!engine) return;
  await engine.setTier(full.derived.evolutionTier);
  engine.setState(spriteStateFor(full.derived.mood));
  engine.start();
}

// ---------------------------------------------------------------------------
// Hearts / HP
// ---------------------------------------------------------------------------

function renderHearts(hp: number, maxHp: number): void {
  heartsEl.replaceChildren();
  const filled = Math.max(0, Math.min(hp, maxHp));
  for (let i = 0; i < maxHp; i++) {
    const span = document.createElement('span');
    span.className = i < filled ? 'heart' : 'heart empty';
    span.textContent = i < filled ? '♥' : '♡';
    span.setAttribute('aria-hidden', 'true');
    heartsEl.append(span);
  }
  heartsEl.setAttribute('aria-label', `${hp} of ${maxHp} HP`);

  // With many hearts the row gets noisy; add a numeric readout alongside.
  if (maxHp > 10) {
    hpTextEl.textContent = `${hp}/${maxHp}`;
    hpTextEl.classList.remove('hidden');
  } else {
    hpTextEl.textContent = '';
    hpTextEl.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Level / evolution progress
// ---------------------------------------------------------------------------

function renderLevel(full: FullState): void {
  const { level } = full.state;
  const per = full.settings.levelsPerEvolution;
  const intoTier = ((level % per) + per) % per;
  const toEvolve = per - intoTier;

  levelLineEl.replaceChildren();
  const main = document.createElement('span');
  main.textContent = `Level ${level}`;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = ` · ${toEvolve} to evolve`;
  levelLineEl.append(main, sub);

  const pct = per > 0 ? (intoTier / per) * 100 : 0;
  evoFillEl.style.width = `${pct}%`;
}

// ---------------------------------------------------------------------------
// Today's stakes
// ---------------------------------------------------------------------------

function renderToday(full: FullState): void {
  const paid = full.state.paidEntriesToday;
  const threshold = full.settings.levelUpThreshold;
  const qualifies = paid < threshold;
  const remaining = threshold - paid;

  const entryWord = paid === 1 ? 'push-through' : 'push-throughs';
  let text: string;
  if (qualifies) {
    const capWord = remaining === 1 ? 'push-through' : 'push-throughs';
    text = `${paid} ${entryWord} today · still on track to level up (${remaining} more ${capWord} would break it).`;
  } else {
    text = `${paid} ${entryWord} today · no level-up today.`;
  }

  todayEl.textContent = text;
  todayEl.classList.toggle('done', !qualifies);
}

// ---------------------------------------------------------------------------
// Lockout countdown
// ---------------------------------------------------------------------------

function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Update the countdown text from the latest state. Returns whether locked. */
function tickCountdown(): boolean {
  const until = current?.state.lockoutUntil;
  if (!current?.derived.inLockout || until == null) return false;
  const remaining = until - Date.now();
  countdownEl.textContent = formatCountdown(remaining);
  if (remaining <= 0) {
    // Lockout elapsed locally; pull authoritative state to leave the wall.
    void refresh();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(full: FullState): void {
  current = full;
  fallbackEl.classList.add('hidden');

  tierBadgeEl.textContent = `Tier ${full.derived.evolutionTier}`;

  void updateSprite(full);

  if (full.derived.inLockout && full.state.lockoutUntil != null) {
    // Somber wall: ghost sprite, de-emphasize the calm stats.
    calmViewEl.classList.add('hidden');
    lockoutViewEl.classList.remove('hidden');
    lockoutMsgEl.textContent =
      'dodgy is gone for now. Every blocked site is locked until it recovers. Sit with it.';
    tickCountdown();
    startCountdown();
  } else {
    lockoutViewEl.classList.add('hidden');
    calmViewEl.classList.remove('hidden');
    stopCountdown();
    renderHearts(full.state.hp, full.settings.maxHp);
    renderLevel(full);
    renderToday(full);
  }
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

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
// Data + init
// ---------------------------------------------------------------------------

async function refresh(): Promise<void> {
  try {
    const full = await sendMessage({ type: 'GET_STATE' });
    render(full);
  } catch {
    // Service worker unreachable (e.g. still spinning up); keep the fallback.
    if (!current) {
      fallbackEl.textContent = 'dodgy is waking up…';
      fallbackEl.classList.remove('hidden');
    }
  }
}

async function init(): Promise<void> {
  settingsBtn.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });

  await initSprite();
  await refresh();

  refreshTimer = setInterval(() => void refresh(), STATE_REFRESH_MS);

  window.addEventListener('unload', () => {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    stopCountdown();
    engine?.stop();
  });
}

void init();
