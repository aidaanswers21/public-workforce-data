import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  isExcludedUrl,
  isSameRegistrableDomain,
  registrableDomain,
  resolveUrl,
  scoreDirectoryUrl,
} from './urls.js';

describe('canonicalizeUrl', () => {
  it('lower-cases the host, drops the fragment and sorts query parameters', () => {
    expect(canonicalizeUrl('https://WWW.Sample-ISD.example.org/Staff?b=2&a=1#team')).toBe(
      'https://www.sample-isd.example.org/Staff?a=1&b=2',
    );
  });

  it('removes tracking parameters so the same page hashes once', () => {
    expect(canonicalizeUrl('https://x.example.org/staff?utm_source=email&page=2')).toBe(
      'https://x.example.org/staff?page=2',
    );
  });

  it('normalizes trailing slashes and default ports', () => {
    expect(canonicalizeUrl('https://x.example.org:443/staff/')).toBe('https://x.example.org/staff');
  });

  it('rejects non-http schemes', () => {
    expect(canonicalizeUrl('mailto:a@b.example.org')).toBeNull();
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
  });
});

/**
 * The locality labels are supplied, never assumed.
 *
 * `registrableDomain` carries no built-in table: a caller that knows nothing
 * about the `.us` locality tree gets ordinary two-label behaviour, and a caller
 * that passes the taxonomy's labels gets the locality-aware answer. These are
 * the labels the taxonomy ships, written out here so the test states its own
 * inputs.
 */
const LOCALITY_LABELS = [
  'k12',
  'co',
  'ci',
  'cc',
  'lib',
  'mus',
  'gen',
  'state',
  'town',
  'vil',
  'tec',
  'dst',
];

describe('registrableDomain', () => {
  it.each([
    // A label sitting directly before the state: the site is one label further left.
    ['staff.sample.k12.tx.us', 'sample.k12.tx.us'],
    // A label before a place name: the site starts at the label, so a county
    // government and a city inside it stay separate sites.
    ['www.co.harris.tx.us', 'co.harris.tx.us'],
    ['parks.ci.austin.tx.us', 'ci.austin.tx.us'],
    ['agency.example.gov', 'example.gov'],
  ])('resolves the locality domain %s to %s', (host, expected) => {
    expect(registrableDomain(host, LOCALITY_LABELS)).toBe(expected);
  });

  it('does not merge two public bodies that merely share a state', () => {
    expect(registrableDomain('co.harris.tx.us', LOCALITY_LABELS)).not.toBe(
      registrableDomain('ci.austin.tx.us', LOCALITY_LABELS),
    );
    expect(registrableDomain('sample.k12.tx.us', LOCALITY_LABELS)).not.toBe(
      registrableDomain('other.k12.tx.us', LOCALITY_LABELS),
    );
  });

  it('carries no built-in locality table: with no labels it stops at two', () => {
    expect(registrableDomain('co.harris.tx.us')).toBe('tx.us');
  });

  it('treats subdomains as the same registrable domain', () => {
    expect(
      isSameRegistrableDomain('www.sample-isd.example.org', 'staff.sample-isd.example.org'),
    ).toBe(true);
    expect(isSameRegistrableDomain('sample-isd.example.org', 'vendor.example.net')).toBe(false);
  });

  it('keeps a county and a city inside it apart when given the labels', () => {
    expect(isSameRegistrableDomain('co.harris.tx.us', 'ci.austin.tx.us', LOCALITY_LABELS)).toBe(
      false,
    );
    expect(
      isSameRegistrableDomain('www.co.harris.tx.us', 'jobs.co.harris.tx.us', LOCALITY_LABELS),
    ).toBe(true);
  });
});

describe('isExcludedUrl', () => {
  it.each([
    'https://x.example.org/calendar/2026-09',
    'https://x.example.org/news/2026/story',
    'https://x.example.org/athletics/schedule',
    'https://x.example.org/handbook.pdf',
    'https://x.example.org/staff?month=9',
    'https://x.example.org/login',
  ])('excludes %s', (url) => {
    expect(isExcludedUrl(url).excluded).toBe(true);
  });

  it('does not exclude a staff directory', () => {
    expect(isExcludedUrl('https://x.example.org/staff-directory?page=2').excluded).toBe(false);
  });
});

describe('scoreDirectoryUrl', () => {
  const hints = [
    { pattern: '/(staff|employee)s?-directory(/|$)', weight: 1.0 },
    { pattern: '/(elected-officials|officials)(/|$)', weight: 0.85 },
    { pattern: '/(field-offices?|regional-offices?)(/|$)', weight: 0.6 },
    { pattern: '/contact-us?(/|$)', weight: 0.35 },
  ];

  it('ranks an explicit directory above a contact page', () => {
    expect(scoreDirectoryUrl('https://x.example.org/staff-directory', hints).score).toBeGreaterThan(
      scoreDirectoryUrl('https://x.example.org/contact-us', hints).score,
    );
  });

  it('recognizes hints from any vertical, having none of its own', () => {
    expect(scoreDirectoryUrl('https://agency.example.gov/field-offices', hints).score).toBe(0.6);
    expect(scoreDirectoryUrl('https://county.example.org/elected-officials', hints).score).toBe(
      0.85,
    );
  });

  it('scores at zero with no hints supplied', () => {
    expect(scoreDirectoryUrl('https://x.example.org/staff-directory', []).score).toBe(0);
  });

  it('scores an excluded url at zero even when the path looks directory-like', () => {
    expect(scoreDirectoryUrl('https://x.example.org/staff/calendar/', hints).score).toBe(0);
  });

  it('ignores a malformed stored pattern instead of throwing', () => {
    expect(() =>
      scoreDirectoryUrl('https://x.example.org/staff', [{ pattern: '([', weight: 1 }]),
    ).not.toThrow();
  });
});

describe('resolveUrl', () => {
  it('resolves relative hrefs against the page', () => {
    expect(resolveUrl('/staff?page=2', 'https://x.example.org/staff')).toBe(
      'https://x.example.org/staff?page=2',
    );
  });

  it('refuses mailto, tel and fragment hrefs', () => {
    expect(resolveUrl('mailto:a@b.example.org', 'https://x.example.org')).toBeNull();
    expect(resolveUrl('#top', 'https://x.example.org')).toBeNull();
  });
});
