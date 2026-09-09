import { describe, expect, it } from 'vitest';
import {
  isAllowedDomain,
  isWithinWebsiteScope,
  websiteSitemapUrl,
  withPolicyDefaults,
} from './policy.js';

const parent = {
  websiteUrl: 'https://agency.example.gov/',
  otherWebsiteUrls: ['https://agency.example.gov/north/', 'https://agency.example.gov/south/'],
};
const child = {
  websiteUrl: 'https://agency.example.gov/north/',
  otherWebsiteUrls: ['https://agency.example.gov/', 'https://agency.example.gov/south/'],
};

describe('organization website boundaries', () => {
  it.each([
    ['https://agency.example.gov/directory', true],
    ['https://www.agency.example.gov/directory', true],
    ['https://north.agency.example.gov/staff', false],
    ['https://agency.example.gov/north', false],
    ['https://agency.example.gov/north/staff', false],
    ['https://agency.example.gov/northern-services', true],
    ['https://agency.example.gov/south/staff', false],
  ])('parent job scopes %s to %s', (url, allowed) => {
    expect(isWithinWebsiteScope(url, parent)).toBe(allowed);
  });
  it.each([
    ['https://agency.example.gov/north/staff?page=2', true],
    ['https://agency.example.gov/north', true],
    ['https://agency.example.gov/staff', false],
    ['https://agency.example.gov/south/staff', false],
    ['https://agency.example.gov/northern/staff', false],
  ])('nested job scopes %s to %s', (url, allowed) => {
    expect(isWithinWebsiteScope(url, child)).toBe(allowed);
  });
  it('keeps a subdomain separate even when domain policy allows the parent', () => {
    const policy = withPolicyDefaults({
      websiteScope: { websiteUrl: 'https://north.agency.example.gov/', otherWebsiteUrls: [] },
    });
    expect(
      isAllowedDomain('https://agency.example.gov/staff', policy.websiteScope!.websiteUrl, policy),
    ).toBe(false);
    expect(
      isAllowedDomain(
        'https://north.agency.example.gov/staff',
        policy.websiteScope!.websiteUrl,
        policy,
      ),
    ).toBe(true);
  });
  it('preserves a published query discriminator', () => {
    const scope = {
      websiteUrl: 'https://agency.example.gov/?site=7',
      otherWebsiteUrls: ['https://agency.example.gov/'],
    };
    expect(isWithinWebsiteScope('https://agency.example.gov/staff?site=7', scope)).toBe(true);
    expect(isWithinWebsiteScope('https://agency.example.gov/staff?site=8', scope)).toBe(false);
    expect(isWithinWebsiteScope('https://agency.example.gov/staff', scope)).toBe(false);
    expect(
      isWithinWebsiteScope('https://agency.example.gov/staff?site=7', {
        websiteUrl: 'https://agency.example.gov/',
        otherWebsiteUrls: [scope.websiteUrl],
      }),
    ).toBe(false);
  });
  it('supports published file homepages and scoped sitemap requests', () => {
    expect(
      isWithinWebsiteScope('https://agency.example.gov/north/staff', {
        websiteUrl: 'https://agency.example.gov/north/index.aspx',
        otherWebsiteUrls: [],
      }),
    ).toBe(true);
    expect(websiteSitemapUrl(child.websiteUrl)).toBe(
      'https://agency.example.gov/north/sitemap.xml',
    );
  });
});
