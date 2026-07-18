import type { FullState, Settings, SpeciesId } from './types';

export type Request =
  | { type: 'GET_STATE' }
  | { type: 'PAY_ENTRY'; domain: string }
  | { type: 'SPARE'; domain: string }
  | { type: 'UPDATE_SETTINGS'; settings: Settings }
  | { type: 'RESET_BLOCKLIST' }
  // --- v1 actions (frozen) ---
  | { type: 'PICK_STARTER'; species: SpeciesId }
  | { type: 'SET_GUARDIAN'; monId: string }
  | { type: 'BUY_EGG'; species: SpeciesId }
  | { type: 'ACK_EVOLUTION'; monId: string };

// ---------------------------------------------------------------------------
// PayEntryResponse
// ---------------------------------------------------------------------------

/** Result of paying to enter a domain. */
export interface PayEntryResponse {
  outcome: 'granted' | 'faint' | 'permadeath' | 'locked' | 'no-guardian';
  hp: number;
  faintStreak: number;
  lockoutUntil: number | null;
  graceExpiresAt: number;
  redirect: boolean;
  /** True when the guardian permadied and the party is now empty. */
  partyEmpty: boolean;
}

/** Response to the v1 party/egg/evolution actions (frozen). */
export interface ActionResponse {
  ok: boolean;
  reason?:
    | 'locked'
    | 'not-found'
    | 'party-not-empty'
    | 'insufficient-coins'
    | 'incubator-full'
    | 'unknown-species'
    | 'no-pending-evolution';
  state: FullState;
}

export interface SpareResponse {
  ok: true;
}

/** Maps each Request type to its response shape. */
export interface ResponseMap {
  GET_STATE: FullState;
  PAY_ENTRY: PayEntryResponse;
  SPARE: SpareResponse;
  UPDATE_SETTINGS: FullState;
  RESET_BLOCKLIST: FullState;
  PICK_STARTER: ActionResponse;
  SET_GUARDIAN: ActionResponse;
  BUY_EGG: ActionResponse;
  ACK_EVOLUTION: ActionResponse;
}

export type ResponseFor<R extends Request> = ResponseMap[R['type']];

/**
 * Typed wrapper over chrome.runtime.sendMessage for use from pages
 * (gate/popup/settings). Resolves with the correctly-typed response.
 */
export function sendMessage<R extends Request>(request: R): Promise<ResponseFor<R>> {
  return chrome.runtime.sendMessage(request) as Promise<ResponseFor<R>>;
}
