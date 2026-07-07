import { describe, expect, it } from 'vitest';
import { domainMatches, normalizeDomain } from './domains';

describe('normalizeDomain', () => {
  it('strips protocol, path, and lowercases', () => {
    expect(normalizeDomain('HTTPS://www.YouTube.com/watch?v=abc')).toBe('youtube.com');
  });

  it('strips port and credentials', () => {
    expect(normalizeDomain('http://user:pass@m.reddit.com:8080/r/all')).toBe('reddit.com');
  });

  it('reduces deep subdomains to eTLD+1', () => {
    expect(normalizeDomain('a.b.c.instagram.com')).toBe('instagram.com');
  });

  it('handles bare domains', () => {
    expect(normalizeDomain('x.com')).toBe('x.com');
    expect(normalizeDomain('tumblr.com')).toBe('tumblr.com');
  });

  it('handles two-part TLDs', () => {
    expect(normalizeDomain('www.bbc.co.uk')).toBe('bbc.co.uk');
    expect(normalizeDomain('shop.example.com.au')).toBe('example.com.au');
    expect(normalizeDomain('sub.site.co.in')).toBe('site.co.in');
  });

  it('strips a trailing dot', () => {
    expect(normalizeDomain('youtube.com.')).toBe('youtube.com');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeDomain('')).toBe('');
    expect(normalizeDomain('   ')).toBe('');
  });
});

describe('domainMatches', () => {
  it('matches subdomains of a blocked domain', () => {
    expect(domainMatches('www.youtube.com', 'youtube.com')).toBe(true);
    expect(domainMatches('m.youtube.com', 'youtube.com')).toBe(true);
    expect(domainMatches('youtube.com', 'youtube.com')).toBe(true);
  });

  it('does not match unrelated domains', () => {
    expect(domainMatches('notyoutube.com', 'youtube.com')).toBe(false);
    expect(domainMatches('youtube.com.evil.com', 'youtube.com')).toBe(false);
  });

  it('matches regardless of protocol/path on either side', () => {
    expect(domainMatches('https://www.reddit.com/r/all', 'reddit.com')).toBe(true);
  });

  it('does not match empty host', () => {
    expect(domainMatches('', 'youtube.com')).toBe(false);
  });
});
