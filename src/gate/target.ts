import { normalizeDomain } from '../shared/domains';

/**
 * Parse the original target URL out of the gate page's raw query string.
 *
 * WHY NOT URLSearchParams: the DNR redirect rule (src/background/rules.ts) uses
 * `regexSubstitution` to embed the RAW matched URL after `?target=`, and DNR does
 * NOT percent-encode it. So a real navigation to
 *   https://youtube.com/watch?v=abc&t=5s
 * produces a gate URL of
 *   ...gate.html?target=https://youtube.com/watch?v=abc&t=5s
 * `new URLSearchParams(search).get('target')` would parse that as three params
 * (`target`, `v`, `t`) and return only `https://youtube.com/watch?v=abc`,
 * silently truncating the URL at the first `&`. We instead take EVERYTHING after
 * the first `target=` verbatim, which round-trips the full original URL.
 *
 * @param search `location.search`, e.g. `?target=https://x.com/a?b=1&c=2`
 *               (leading `?` optional).
 * @returns the raw target string, or `''` if there is no `target=` param.
 */
export function extractRawTarget(search: string): string {
  const s = search.startsWith('?') ? search.slice(1) : search;
  const key = 'target=';
  const idx = s.indexOf(key);
  if (idx === -1) return '';
  return s.slice(idx + key.length);
}

/**
 * Parse + validate the gate target from a raw query string. Returns the
 * canonical target URL and its registrable domain, or `null` when the param is
 * missing or is not a navigable http(s) URL.
 */
export function parseTarget(
  search: string,
): { target: string; domain: string } | null {
  const raw = extractRawTarget(search);
  if (!raw) return null;

  let target: string;
  try {
    // The raw value may or may not be percent-encoded depending on the source;
    // `new URL` accepts both forms. Validate it's an http(s) URL we can load.
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
