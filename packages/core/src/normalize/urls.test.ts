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

describe('registrableDomain', () => {
  it('handles the k12 state suffix school districts use', () => {
    expect(registrableDomain('staff.sample.k12.tx.us')).toBe('sample.k12.tx.us');
  });

  it('treats subdomains as the same registrable domain', () => {
    expect(
      isSameRegistrableDomain('www.sample-isd.example.org', 'staff.sample-isd.example.org'),
    ).toBe(true);
    expect(isSameRegistrableDomain('sample-isd.example.org', 'vendor.example.net')).toBe(false);
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
  it('ranks an explicit staff directory above a contact page', () => {
    expect(scoreDirectoryUrl('https://x.example.org/staff-directory').score).toBeGreaterThan(
      scoreDirectoryUrl('https://x.example.org/contact-us').score,
    );
  });

  it('scores an excluded url at zero even when the path looks directory-like', () => {
    expect(scoreDirectoryUrl('https://x.example.org/staff/calendar/').score).toBe(0);
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
