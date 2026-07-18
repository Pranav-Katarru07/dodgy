// chrome.alarms management. Alarm *handlers* live in index.ts; this module only
// schedules and clears alarms and helps parse their names.
//
// v1: lockout ends at local midnight (the daily-rollover alarm IS the lockout
// end), so there is no dedicated lockout-end alarm. `nextLocalMidnight` is the
// pure time helper from the state machine.
import { ALARMS } from '../shared/constants';
import { nextLocalMidnight } from './state';

export function scheduleDailyRollover(): void {
  chrome.alarms.create(ALARMS.dailyRollover, { when: nextLocalMidnight(Date.now()) });
}

export function scheduleGraceExpiry(domain: string, expiresAt: number): void {
  chrome.alarms.create(`${ALARMS.gracePrefix}${domain}`, { when: expiresAt });
}

export async function clearGraceAlarm(domain: string): Promise<void> {
  await chrome.alarms.clear(`${ALARMS.gracePrefix}${domain}`);
}

/**
 * Clear every grace alarm except the one for exceptDomain. Used at faint/
 * permadeath so the fatal domain's own grace alarm survives.
 */
export async function clearAllGraceAlarms(exceptDomain: string | null): Promise<void> {
  const all = await chrome.alarms.getAll();
  const keepName = exceptDomain == null ? null : `${ALARMS.gracePrefix}${exceptDomain}`;
  await Promise.all(
    all
      .filter((a) => a.name.startsWith(ALARMS.gracePrefix) && a.name !== keepName)
      .map((a) => chrome.alarms.clear(a.name)),
  );
}

/** Extract the domain from a grace alarm name, or null if not a grace alarm. */
export function graceDomainFromAlarmName(name: string): string | null {
  if (!name.startsWith(ALARMS.gracePrefix)) return null;
  return name.slice(ALARMS.gracePrefix.length);
}
