// declarativeNetRequest dynamic-rule management. Each blocklist domain
// (subdomain-inclusive, main_frame only) redirects to the gate page, carrying
// the ORIGINAL url as ?target=.
//
// TARGET-URL EMBEDDING
// --------------------
// A plain redirect.url cannot carry the matched URL, so we use
// regexFilter + redirect.regexSubstitution. We wrap the WHOLE matched URL in a
// single capture group and reference it as \1 in the substitution. (\0 is also
// the full match, but an explicit capture group is unambiguous and robust.)
//
// regexFilter:  ^(https?://([^/]*\.)?<ESCAPED_DOMAIN>(?:[:/?#].*)?)$
//   - group 1  = the entire URL (used as \1)
//   - ([^/]*\.)? = optional subdomain prefix (subdomain-inclusive)
//   - <ESCAPED_DOMAIN> with all regex metacharacters escaped (dots -> \.)
//   - (?:[:/?#].*)? = optional port/path/query/fragment, or bare host
//
// regexSubstitution: chrome-extension://<id>/src/gate/gate.html?target=\1
//   DNR does NOT URL-encode the substitution; the gate reads params.get('target'),
//   which is acceptable for v1.
//
// Rule ids are stable and derived from the (normalized, deduped) blocklist
// ordering: id = index + 1. We never persist a domain->id map; we recompute it
// from settings.blocklist on demand.
import { normalizeDomain } from '../shared/domains';

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/** Escape regex metacharacters so a domain matches literally. */
export function escapeRegex(domain: string): string {
  return domain.replace(REGEX_META, '\\$&');
}

/** Build the single DNR rule for one domain at the given stable id. */
export function buildRuleForDomain(
  domain: string,
  id: number,
): chrome.declarativeNetRequest.Rule {
  const escaped = escapeRegex(domain);
  const regexFilter = `^(https?://([^/]*\\.)?${escaped}(?:[:/?#].*)?)$`;
  const regexSubstitution = `chrome-extension://${chrome.runtime.id}/src/gate/gate.html?target=\\1`;

  return {
    id,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
      redirect: { regexSubstitution },
    },
    condition: {
      regexFilter,
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
    },
  };
}

/**
 * Normalize + dedupe a blocklist, preserving first-seen order. The resulting
 * array's indices define the stable rule ids (id = index + 1).
 */
function normalizeBlocklist(blocklist: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of blocklist) {
    const d = normalizeDomain(entry);
    if (d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

/** Compute the stable rule id for a domain in the current blocklist, or null. */
function ruleIdForDomain(blocklist: string[], domain: string): number | null {
  const norm = normalizeBlocklist(blocklist);
  const target = normalizeDomain(domain);
  const idx = norm.indexOf(target);
  return idx === -1 ? null : idx + 1;
}

/** Validate a rule's regex; log and skip if unsupported. */
async function isRuleRegexSupported(rule: chrome.declarativeNetRequest.Rule): Promise<boolean> {
  const regex = rule.condition.regexFilter;
  if (!regex) return true;
  try {
    const res = await chrome.declarativeNetRequest.isRegexSupported({ regex });
    if (!res.isSupported) {
      console.warn('[dodgy] skipping unsupported regex rule', rule.id, regex, res.reason);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[dodgy] isRegexSupported threw for rule', rule.id, e);
    return false;
  }
}

async function currentRuleIds(): Promise<number[]> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  return existing.map((r) => r.id);
}

/**
 * Remove ALL existing dynamic rules and add fresh rules for the current
 * blocklist. Regexes are validated individually so one bad domain cannot cause
 * the whole updateDynamicRules batch to be rejected.
 */
export async function rebuildRules(blocklist: string[]): Promise<void> {
  const removeRuleIds = await currentRuleIds();
  const norm = normalizeBlocklist(blocklist);

  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  for (let i = 0; i < norm.length; i++) {
    const rule = buildRuleForDomain(norm[i], i + 1);
    if (await isRuleRegexSupported(rule)) {
      addRules.push(rule);
    }
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

/** Remove a single domain's rule (grace granted). No-op if not present. */
export async function disableRuleForDomain(blocklist: string[], domain: string): Promise<void> {
  const id = ruleIdForDomain(blocklist, domain);
  if (id == null) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [id] });
}

/** Re-add a single domain's rule (grace expired) if not already present. */
export async function enableRuleForDomain(blocklist: string[], domain: string): Promise<void> {
  const norm = normalizeBlocklist(blocklist);
  const target = normalizeDomain(domain);
  const idx = norm.indexOf(target);
  if (idx === -1) return;

  const id = idx + 1;
  const existingIds = new Set(await currentRuleIds());
  if (existingIds.has(id)) return;

  const rule = buildRuleForDomain(norm[idx], id);
  if (!(await isRuleRegexSupported(rule))) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
}

/**
 * Re-add every domain's rule EXCEPT exceptDomain's (lockout start honoring the
 * fatal-domain grace pass). Only adds rules that are currently missing.
 */
export async function restoreAllExcept(
  blocklist: string[],
  exceptDomain: string | null,
): Promise<void> {
  const norm = normalizeBlocklist(blocklist);
  const except = exceptDomain == null ? null : normalizeDomain(exceptDomain);
  const existingIds = new Set(await currentRuleIds());

  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  for (let i = 0; i < norm.length; i++) {
    const domain = norm[i];
    if (except != null && domain === except) continue;
    const id = i + 1;
    if (existingIds.has(id)) continue;
    const rule = buildRuleForDomain(domain, id);
    if (await isRuleRegexSupported(rule)) {
      addRules.push(rule);
    }
  }

  if (addRules.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules });
  }
}
