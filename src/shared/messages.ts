import type { FullState, Settings } from './types';

export type Request =
  | { type: 'GET_STATE' }
  | { type: 'PAY_ENTRY'; domain: string }
  | { type: 'SPARE'; domain: string }
  | { type: 'UPDATE_SETTINGS'; settings: Settings }
  | { type: 'RESET_BLOCKLIST' };

/**
 * Result of paying 1 HP to enter a domain.
 * `redirect` is always true: even the fatal blow grants a grace pass for that
 * one domain and loads the target site (product decision #2). On 'death' the
 * lockout applies to every OTHER domain immediately.
 */
export interface PayEntryResponse {
  outcome: 'granted' | 'death';
  hp: number;
  lockoutUntil: number | null;
  graceExpiresAt: number;
  redirect: true;
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
}

export type ResponseFor<R extends Request> = ResponseMap[R['type']];

/**
 * Typed wrapper over chrome.runtime.sendMessage for use from pages
 * (gate/popup/settings). Resolves with the correctly-typed response.
 */
export function sendMessage<R extends Request>(request: R): Promise<ResponseFor<R>> {
  return chrome.runtime.sendMessage(request) as Promise<ResponseFor<R>>;
}
