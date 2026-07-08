import { extractRawTarget, parseTarget } from './target';

describe('extractRawTarget', () => {
  it('returns everything after the first target=', () => {
    expect(extractRawTarget('?target=https://youtube.com/')).toBe(
      'https://youtube.com/',
    );
  });

  it('does NOT truncate a raw URL containing & query params', () => {
    // The bug that URLSearchParams.get would cause: everything after the first
    // & is lost. The whole original URL must survive.
    const raw = 'https://youtube.com/watch?v=abc&t=5s&list=xyz';
    expect(extractRawTarget(`?target=${raw}`)).toBe(raw);
  });

  it('preserves a raw URL containing a ? in its own query', () => {
    const raw = 'https://x.com/i/status/1?ref=home';
    expect(extractRawTarget(`?target=${raw}`)).toBe(raw);
  });

  it('works without a leading ?', () => {
    expect(extractRawTarget('target=https://reddit.com/r/all')).toBe(
      'https://reddit.com/r/all',
    );
  });

  it('returns empty string when there is no target param', () => {
    expect(extractRawTarget('?foo=bar')).toBe('');
    expect(extractRawTarget('')).toBe('');
  });
});

describe('parseTarget', () => {
  it('round-trips a full URL with & query params (the truncation bug)', () => {
    const raw = 'https://youtube.com/watch?v=abc&t=5s';
    const out = parseTarget(`?target=${raw}`);
    expect(out).not.toBeNull();
    expect(out!.target).toBe(raw);
    expect(out!.domain).toBe('youtube.com');
  });

  it('normalizes the domain to eTLD+1 from a subdomain', () => {
    const out = parseTarget('?target=https://m.youtube.com/feed');
    expect(out!.domain).toBe('youtube.com');
  });

  it('rejects a missing target', () => {
    expect(parseTarget('?foo=bar')).toBeNull();
    expect(parseTarget('')).toBeNull();
  });

  it('rejects non-http(s) schemes', () => {
    expect(parseTarget('?target=javascript:alert(1)')).toBeNull();
    expect(parseTarget('?target=file:///etc/passwd')).toBeNull();
  });

  it('rejects a non-URL target', () => {
    expect(parseTarget('?target=not a url')).toBeNull();
  });

  it('accepts a target whose path is percent-encoded (scheme intact)', () => {
    // DNR appends the raw URL, so the scheme/host are never encoded; only the
    // original URL's own encoded path segments appear. new URL handles these.
    const out = parseTarget('?target=https://reddit.com/r/all%2Fnew?sort=new');
    expect(out!.domain).toBe('reddit.com');
  });
});
