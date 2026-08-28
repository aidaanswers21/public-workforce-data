import { describe, expect, it } from 'vitest';
import {
  decodeCloudflareEmail,
  decodeHtmlEntities,
  decodeSpelledOut,
  extractEmailsFromText,
  isSyntacticallyValidEmail,
  parseMailtoHref,
} from './obfuscation.js';

/** Cloudflare XORs each byte with the first byte of the payload. */
function cfEncode(address: string, key = 0x2a): string {
  let out = key.toString(16).padStart(2, '0');
  for (const char of address) out += (char.charCodeAt(0) ^ key).toString(16).padStart(2, '0');
  return out;
}

describe('isSyntacticallyValidEmail', () => {
  it.each([
    'jane.smith@sample-isd.example.org',
    "o'brien@sample-isd.example.org",
    'a_b+c@x.example.org',
  ])('accepts %s', (address) => {
    expect(isSyntacticallyValidEmail(address)).toBe(true);
  });

  it.each([
    '',
    'no-at-sign.example.org',
    'two@@example.org',
    '.leading@example.org',
    'trailing.@example.org',
    'double..dot@example.org',
    'missing-tld@example',
    'spaces in@example.org',
  ])('rejects %s', (address) => {
    expect(isSyntacticallyValidEmail(address)).toBe(false);
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes numeric and hex entities', () => {
    expect(decodeHtmlEntities('&#104;&#105;&#64;x&#46;org')).toBe('hi@x.org');
    expect(decodeHtmlEntities('&#x68;&#x69;&#x40;x.org')).toBe('hi@x.org');
  });

  it('leaves unknown named entities alone', () => {
    expect(decodeHtmlEntities('a &widget; b')).toBe('a &widget; b');
  });
});

describe('decodeCloudflareEmail', () => {
  it('round-trips an encoded address', () => {
    const address = 'hidden.person@sample-isd.example.org';
    expect(decodeCloudflareEmail(cfEncode(address))).toBe(address);
  });

  it('returns null for payloads that do not decode to an address', () => {
    expect(decodeCloudflareEmail('zzzz')).toBeNull();
    expect(decodeCloudflareEmail('2a')).toBeNull();
    expect(decodeCloudflareEmail('2a4243')).toBeNull();
  });
});

describe('decodeSpelledOut', () => {
  it('recovers a fully spelled out address without losing local-part segments', () => {
    const [found] = decodeSpelledOut('samuel dot ortiz at sample-isd dot example dot org');
    expect(found?.address).toBe('samuel.ortiz@sample-isd.example.org');
    expect(found?.obfuscation).toBe('at_dot_words');
  });

  it('recovers a bracketed address and labels it as bracketed', () => {
    const [found] = decodeSpelledOut('nadia.haddad [at] sample-isd.example.org');
    expect(found?.address).toBe('nadia.haddad@sample-isd.example.org');
    expect(found?.obfuscation).toBe('bracketed_at');
  });
});

describe('extractEmailsFromText', () => {
  it('finds plain, entity-encoded and spelled-out addresses in one pass', () => {
    const text = [
      'plain@sample-isd.example.org',
      '&#101;&#110;&#116;&#105;&#116;&#121;&#64;sample-isd&#46;example&#46;org',
      'spelled dot out at sample-isd dot example dot org',
    ].join(' | ');
    const addresses = extractEmailsFromText(text)
      .map((email) => email.address)
      .sort();
    expect(addresses).toEqual([
      'entity@sample-isd.example.org',
      'plain@sample-isd.example.org',
      'spelled.out@sample-isd.example.org',
    ]);
  });

  it('does not return the same address twice', () => {
    const found = extractEmailsFromText('a@x.example.org and again a@x.example.org');
    expect(found).toHaveLength(1);
  });

  it('strips trailing sentence punctuation', () => {
    expect(extractEmailsFromText('Write to jane@x.example.org.')[0]?.address).toBe(
      'jane@x.example.org',
    );
  });
});

describe('parseMailtoHref', () => {
  it('reads a plain mailto', () => {
    expect(parseMailtoHref('mailto:Jane.Smith@X.example.org')?.address).toBe(
      'jane.smith@x.example.org',
    );
  });

  it('drops subject parameters and decodes percent encoding', () => {
    expect(parseMailtoHref('mailto:jane%40x.example.org?subject=Hi')?.address).toBe(
      'jane@x.example.org',
    );
  });

  it('returns null for a non-mailto href', () => {
    expect(parseMailtoHref('/staff/jane')).toBeNull();
  });
});
