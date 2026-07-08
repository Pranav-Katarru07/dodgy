// Settings page: edit the Settings object + blocklist via the service worker.
import { sendMessage } from '../shared/messages';
import { normalizeDomain } from '../shared/domains';
import type { FullState, Settings } from '../shared/types';

/** Numeric settings keys (everything on Settings except the blocklist). */
type NumericKey = Exclude<keyof Settings, 'blocklist'>;

interface FieldSpec {
  key: NumericKey;
  label: string;
  explain: string;
  /** Inclusive minimum, mirroring the service worker's validation. */
  min: number;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  {
    key: 'maxHp',
    label: 'Max HP',
    explain:
      "dodgy's full health — how many push-throughs in one day it takes to kill dodgy.",
    min: 1,
  },
  {
    key: 'damagePerEntry',
    label: 'Damage per entry',
    explain: 'HP dodgy loses each time you push past the block.',
    min: 1,
  },
  {
    key: 'levelUpThreshold',
    label: 'Level-up threshold',
    explain:
      'dodgy grows on any day you push through fewer than this many times.',
    min: 1,
  },
  {
    key: 'levelsPerEvolution',
    label: 'Levels per evolution',
    explain: 'How many levels between each evolution into a new form.',
    min: 1,
  },
  {
    key: 'graceMinutes',
    label: 'Grace minutes',
    explain:
      'After paying, the site stays open this long before dodgy re-guards it.',
    min: 0,
  },
  {
    key: 'lockoutHours',
    label: 'Lockout hours',
    explain: 'If dodgy dies, every blocked site stays locked for this long.',
    min: 1,
  },
];

/** The form's working copy of Settings; edits stage here until Save. */
let working: Settings;

// ---- DOM lookups (page markup is fixed, so these are asserted non-null). ----
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

const appEl = byId<HTMLElement>('app');
const formEl = byId<HTMLFormElement>('settings-form');
const fieldsEl = byId<HTMLDivElement>('fields');
const blocklistEl = byId<HTMLUListElement>('blocklist');
const addInput = byId<HTMLInputElement>('add-domain-input');
const addBtn = byId<HTMLButtonElement>('add-domain-btn');
const addError = byId<HTMLParagraphElement>('add-domain-error');
const resetBtn = byId<HTMLButtonElement>('reset-blocklist-btn');
const saveBtn = byId<HTMLButtonElement>('save-btn');
const savedRegion = byId<HTMLSpanElement>('saved-region');

/** Live registry of the numeric inputs, keyed by setting. */
const inputs = new Map<NumericKey, HTMLInputElement>();
const errorEls = new Map<NumericKey, HTMLElement>();

// ---------------------------------------------------------------------------
// Field construction
// ---------------------------------------------------------------------------

function buildFields(): void {
  fieldsEl.replaceChildren();
  inputs.clear();
  errorEls.clear();

  for (const spec of FIELD_SPECS) {
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const inputId = `field-${spec.key}`;
    const errorId = `error-${spec.key}`;

    const label = document.createElement('label');
    label.htmlFor = inputId;
    label.textContent = spec.label;

    const explain = document.createElement('span');
    explain.className = 'explain';
    explain.textContent = spec.explain;

    const input = document.createElement('input');
    input.type = 'number';
    input.id = inputId;
    input.step = '1';
    input.min = String(spec.min);
    input.inputMode = 'numeric';
    input.setAttribute('aria-describedby', errorId);

    const error = document.createElement('p');
    error.className = 'error';
    error.id = errorId;
    error.setAttribute('role', 'alert');

    input.addEventListener('input', () => {
      validateField(spec);
      refreshSaveState();
    });

    wrap.append(label, explain, input, error);
    fieldsEl.append(wrap);

    inputs.set(spec.key, input);
    errorEls.set(spec.key, error);
  }
}

// ---------------------------------------------------------------------------
// Validation (mirrors the service worker: integers, per-field minimums)
// ---------------------------------------------------------------------------

/** Validate one field, update aria/error UI, and return whether it's valid. */
function validateField(spec: FieldSpec): boolean {
  const input = inputs.get(spec.key)!;
  const error = errorEls.get(spec.key)!;
  const raw = input.value.trim();

  let message = '';
  if (raw === '') {
    message = 'Enter a whole number.';
  } else {
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      message = 'Must be a whole number.';
    } else if (value < spec.min) {
      message = `Must be at least ${spec.min}.`;
    }
  }

  const valid = message === '';
  if (valid) {
    // Only stage a value we know is a clean integer.
    working[spec.key] = Number(raw);
  }

  input.setAttribute('aria-invalid', valid ? 'false' : 'true');
  error.textContent = message;
  error.classList.toggle('visible', !valid);
  return valid;
}

/** True only when every numeric field currently validates. */
function allValid(): boolean {
  let ok = true;
  for (const spec of FIELD_SPECS) {
    // Evaluate every field (no short-circuit) so all errors stay visible.
    if (!validateField(spec)) ok = false;
  }
  return ok;
}

function refreshSaveState(): void {
  saveBtn.disabled = !allValid();
}

// ---------------------------------------------------------------------------
// Blocklist
// ---------------------------------------------------------------------------

function renderBlocklist(): void {
  blocklistEl.replaceChildren();

  if (working.blocklist.length === 0) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'empty';
    span.textContent = 'No sites blocked.';
    li.append(span);
    blocklistEl.append(li);
    return;
  }

  for (const domain of working.blocklist) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.textContent = domain;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-btn';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${domain}`);
    remove.addEventListener('click', () => {
      working.blocklist = working.blocklist.filter((d) => d !== domain);
      renderBlocklist();
    });

    li.append(name, remove);
    blocklistEl.append(li);
  }
}

function showAddError(message: string): void {
  addError.textContent = message;
  addError.classList.toggle('visible', message !== '');
  addInput.setAttribute('aria-invalid', message === '' ? 'false' : 'true');
}

function handleAddDomain(): void {
  const normalized = normalizeDomain(addInput.value);
  if (normalized === '') {
    showAddError('Enter a valid domain, e.g. youtube.com.');
    return;
  }
  if (working.blocklist.includes(normalized)) {
    showAddError(`${normalized} is already blocked.`);
    return;
  }
  working.blocklist = [...working.blocklist, normalized];
  addInput.value = '';
  showAddError('');
  renderBlocklist();
  addInput.focus();
}

async function handleResetBlocklist(): Promise<void> {
  const confirmed = window.confirm(
    'Reset the blocklist to dodgy’s defaults? This saves immediately.',
  );
  if (!confirmed) return;
  const full = await sendMessage({ type: 'RESET_BLOCKLIST' });
  render(full);
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

let savedTimer: ReturnType<typeof setTimeout> | undefined;

async function handleSave(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!allValid()) {
    refreshSaveState();
    return;
  }
  saveBtn.disabled = true;
  const full = await sendMessage({ type: 'UPDATE_SETTINGS', settings: working });
  render(full);

  savedRegion.textContent = 'Saved ✓';
  savedRegion.classList.add('visible');
  if (savedTimer !== undefined) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedRegion.classList.remove('visible');
    savedRegion.textContent = '';
  }, 2000);
}

// ---------------------------------------------------------------------------
// Render + init
// ---------------------------------------------------------------------------

/** Re-render the whole form from an authoritative FullState. */
function render(full: FullState): void {
  // Fresh working copy so staged edits don't leak across renders.
  working = { ...full.settings, blocklist: [...full.settings.blocklist] };

  for (const spec of FIELD_SPECS) {
    const input = inputs.get(spec.key)!;
    input.value = String(working[spec.key]);
  }
  renderBlocklist();
  showAddError('');
  refreshSaveState();
}

async function init(): Promise<void> {
  buildFields();

  addBtn.addEventListener('click', handleAddDomain);
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddDomain();
    }
  });
  addInput.addEventListener('input', () => showAddError(''));
  resetBtn.addEventListener('click', () => void handleResetBlocklist());
  formEl.addEventListener('submit', (e) => void handleSave(e));

  const full = await sendMessage({ type: 'GET_STATE' });
  render(full);
  appEl.hidden = false;
}

void init();
