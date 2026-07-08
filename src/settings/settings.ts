// Settings page: edit the Settings object + blocklist via the service worker.
import { sendMessage } from '../shared/messages';
import { normalizeDomain } from '../shared/domains';
import type { FullState, Settings } from '../shared/types';

/** Numeric settings keys (the number-valued fields of Settings). */
type NumericKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];

/** Text settings keys (the string-valued fields of Settings). */
type TextKey = {
  [K in keyof Settings]: Settings[K] extends string ? K : never;
}[keyof Settings];

/** Any editable field key rendered by the form. */
type FieldKey = NumericKey | TextKey;

interface NumberFieldSpec {
  kind: 'number';
  key: NumericKey;
  label: string;
  explain: string;
  /** Inclusive minimum, mirroring the service worker's validation. */
  min: number;
}

interface TextFieldSpec {
  kind: 'text';
  key: TextKey;
  label: string;
  explain: string;
  /** Inclusive maximum character length after trimming. */
  maxLen: number;
}

type FieldSpec = NumberFieldSpec | TextFieldSpec;

// Field order mirrors PRD §11: pokedexTitle first, then the core numerics, then
// the Pokémon v1 numerics.
const FIELD_SPECS: readonly FieldSpec[] = [
  {
    kind: 'text',
    key: 'pokedexTitle',
    label: 'Pokédex title',
    explain: 'Name shown across the top of your Pokédex screen.',
    maxLen: 24,
  },
  {
    kind: 'number',
    key: 'maxHp',
    label: 'Max HP',
    explain:
      "Your guardian's full health — how many push-throughs in one day it takes to faint it.",
    min: 1,
  },
  {
    kind: 'number',
    key: 'damagePerEntry',
    label: 'Damage per entry',
    explain: 'HP your guardian loses each time you push past the block.',
    min: 1,
  },
  {
    kind: 'number',
    key: 'levelUpThreshold',
    label: 'Level-up threshold',
    explain:
      'Your guardian gains a level on any day you push through fewer than this many times.',
    min: 1,
  },
  {
    kind: 'number',
    key: 'graceMinutes',
    label: 'Grace minutes',
    explain:
      'After paying, the site stays open this long before your guardian re-guards it.',
    min: 0,
  },
  {
    kind: 'number',
    key: 'starterLevel',
    label: 'Starter level',
    explain: 'Level a freshly-picked starter or newly-hatched egg begins at.',
    min: 1,
  },
  {
    kind: 'number',
    key: 'faintLevelPenalty',
    label: 'Faint level penalty',
    explain: 'Levels lost when your guardian faints (it never devolves).',
    min: 0,
  },
  {
    kind: 'number',
    key: 'faintStreakToPermadeath',
    label: 'Faints to permadeath',
    explain:
      'Consecutive faints before your guardian is gone for good — a clean guarding day resets the streak.',
    min: 1,
  },
  {
    kind: 'number',
    key: 'baseReward',
    label: 'Base reward',
    explain: 'PokéCoins earned for a full day your guardian survives untouched.',
    min: 0,
  },
  {
    kind: 'number',
    key: 'eggCost',
    label: 'Egg cost',
    explain: 'PokéCoins one species egg costs at the shop.',
    min: 1,
  },
  {
    kind: 'number',
    key: 'daysToHatch',
    label: 'Days to hatch',
    explain:
      "Clean days needed to hatch an egg — messy days don't reset progress.",
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

/** Live registry of the field inputs, keyed by setting. */
const inputs = new Map<FieldKey, HTMLInputElement>();
const errorEls = new Map<FieldKey, HTMLElement>();

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
    input.id = inputId;
    input.setAttribute('aria-describedby', errorId);

    if (spec.kind === 'number') {
      input.type = 'number';
      input.step = '1';
      input.min = String(spec.min);
      input.inputMode = 'numeric';
    } else {
      input.type = 'text';
      input.maxLength = spec.maxLen;
      input.autocomplete = 'off';
    }

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
// Validation (mirrors the service worker's validateSettings)
// ---------------------------------------------------------------------------

/** Validate one field, update aria/error UI, and return whether it's valid. */
function validateField(spec: FieldSpec): boolean {
  const input = inputs.get(spec.key)!;
  const error = errorEls.get(spec.key)!;

  let message = '';
  if (spec.kind === 'number') {
    const raw = input.value.trim();
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
    if (message === '') {
      // Only stage a value we know is a clean integer.
      working[spec.key] = Number(raw);
    }
  } else {
    const trimmed = input.value.trim();
    if (trimmed === '') {
      message = 'Enter a title.';
    } else if (trimmed.length > spec.maxLen) {
      message = `Must be ${spec.maxLen} characters or fewer.`;
    }
    if (message === '') {
      // Stage the trimmed title so it matches what the SW will persist.
      working[spec.key] = trimmed;
    }
  }

  const valid = message === '';
  input.setAttribute('aria-invalid', valid ? 'false' : 'true');
  error.textContent = message;
  error.classList.toggle('visible', !valid);
  return valid;
}

/** True only when every field currently validates. */
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
    li.className = 'empty-row';
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
    name.className = 'domain';
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
    'Reset the blocklist to the default set? This saves immediately.',
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
  // `working` is the stored Settings spread + our edited fields. UPDATE_SETTINGS
  // sends the full object.
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
