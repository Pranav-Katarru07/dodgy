// chrome.alarms management. Alarm *handlers* live in index.ts; this module only
// schedules and clears alarms and helps parse their names.
import { ALARMS } from '../shared/constants';

/** Epoch ms of the next local midnight after now. */
function nextLocalMidnight(): number {
  const d = new Date();
  d.setHours(24, 0, 0, 0); // rolls into tomorrow at local 00:00:00.000
  return d.getTime();
}

export function scheduleDailyRollover(): void {
  chrome.alarms.create(ALARMS.dailyRollover, { when: nextLocalMidnight() });
}

export function scheduleLockoutEnd(lockoutUntil: number): void {
  chrome.alarms.create(ALARMS.lockoutEnd, { when: lockoutUntil });
}

export function scheduleGraceExpiry(domain: string, expiresAt: number): void {
  chrome.alarms.create(`${ALARMS.gracePrefix}${domain}`, { when: expiresAt });
}

export async function clearGraceAlarm(domain: string): Promise<void> {
  await chrome.alarms.clear(`${ALARMS.gracePrefix}${domain}`);
}

/**
 * Clear every grace alarm except the one for exceptDomain. Used at lockout start
 * so the fatal domain's own grace alarm survives.
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
