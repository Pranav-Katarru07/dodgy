/**
 * Pragmatic v1 eTLD+1 normalization. Not a full Public Suffix List — it takes
 * the last two labels, except for a small hardcoded set of two-part TLDs where
 * it takes the last three.
 */
const TWO_PART_TLDS: ReadonlySet<string> = new Set([
  'co.uk',
  'com.au',
  'co.jp',
  'com.br',
  'co.in',
]);

/**
 * Strip protocol/path/port/credentials, lowercase, and reduce a host to its
 * registrable domain (eTLD+1-ish). Returns '' for empty/invalid input.
 */
export function normalizeDomain(input: string): string {
  if (!input) return '';
  let host = input.trim().toLowerCase();

  // Strip scheme.
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // Strip credentials.
  host = host.replace(/^[^/@]*@/, '');
  // Strip path/query/fragment.
  host = host.replace(/[/?#].*$/, '');
  // Strip port.
  host = host.replace(/:\d+$/, '');
  // Strip a trailing dot (fully-qualified form).
  host = host.replace(/\.$/, '');

  if (!host) return '';

  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');

  const lastTwo = labels.slice(-2).join('.');
  if (TWO_PART_TLDS.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Subdomain-inclusive match: does `host` belong to the blocked registrable
 * domain `blocked`? e.g. domainMatches('www.youtube.com', 'youtube.com') → true.
 */
export function domainMatches(host: string, blocked: string): boolean {
  const h = normalizeDomain(host);
  const b = normalizeDomain(blocked);
  return h !== '' && h === b;
}
