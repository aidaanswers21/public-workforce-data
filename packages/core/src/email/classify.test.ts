import { describe, expect, it } from 'vitest';
import { parsePersonName } from '../normalize/names.js';
import { canReplaceClassification, classifyEmail, localPartMatchesName } from './classify.js';

const jane = parsePersonName('Jane Smith');

/** A small vocabulary. The composed one is exercised in the sector tests. */
const SHARED_INBOX = {
  localParts: [
    'info',
    'office',
    'frontoffice',
    'webmaster',
    'noreply',
    'clerk',
    'permits',
    'records',
    'foia',
    'dispatch',
    'hr',
  ],
  prefixes: ['info', 'office', 'hr', 'noreply'],
};

describe('classifyEmail', () => {
  it('marks a plainly displayed address as published', () => {
    const result = classifyEmail({
      address: 'jane.smith@sample-isd.example.org',
      obfuscation: 'none',
      origin: 'observed',
      personName: jane,
    });
    expect(result.classification).toBe('published');
  });

  it('marks a decoded address as decoded_published, not published', () => {
    const result = classifyEmail({
      address: 'jane.smith@sample-isd.example.org',
      obfuscation: 'cloudflare_cfemail',
      origin: 'observed',
      personName: jane,
    });
    expect(result.classification).toBe('decoded_published');
  });

  it('never calls a generated address published', () => {
    const result = classifyEmail({
      address: 'jane.smith@sample-isd.example.org',
      obfuscation: 'none',
      origin: 'inferred',
      personName: jane,
    });
    expect(result.classification).toBe('inferred_candidate');
  });

  it.each([
    'info@agency.example.gov',
    'office@county.example.org',
    'frontoffice@sample-isd.example.org',
    'webmaster@city.example.gov',
    'foia@agency.example.gov',
    'noreply@county.example.org',
  ])('classifies %s as a general inbox', (address) => {
    const result = classifyEmail({
      address,
      obfuscation: 'none',
      origin: 'observed',
      sharedInbox: SHARED_INBOX,
    });
    expect(result.classification).toBe('general_inbox');
    expect(result.isGeneralInbox).toBe(true);
  });

  it('has no built-in inbox vocabulary: with none supplied nothing is shared', () => {
    const result = classifyEmail({
      address: 'info@agency.example.gov',
      obfuscation: 'none',
      origin: 'observed',
    });
    expect(result.classification).toBe('published');
    expect(result.isGeneralInbox).toBe(false);
  });

  it('does not treat a person address as a shared inbox just because it starts with a role word', () => {
    const result = classifyEmail({
      address: 'hrobinson@county.example.org',
      obfuscation: 'none',
      origin: 'observed',
      personName: parsePersonName('Helen Robinson'),
      sharedInbox: SHARED_INBOX,
    });
    expect(result.classification).toBe('published');
  });

  it('marks a malformed address invalid', () => {
    expect(
      classifyEmail({ address: 'not-an-email', obfuscation: 'none', origin: 'observed' })
        .classification,
    ).toBe('invalid');
  });

  it('never returns suppressed: suppression is an overlay, not a property of the address', () => {
    const results = (['none', 'html_entity', 'cloudflare_cfemail'] as const).map(
      (obfuscation) =>
        classifyEmail({ address: 'jane@x.example.org', obfuscation, origin: 'observed' })
          .classification,
    );
    expect(results).not.toContain('suppressed');
  });
});

describe('localPartMatchesName', () => {
  it.each([
    ['jane.smith', true],
    ['jsmith', true],
    ['smithj', true],
    ['janes', true],
    ['smith', true],
    ['info', false],
    ['principal', false],
  ])('matches %s against Jane Smith: %s', (localPart, expected) => {
    expect(localPartMatchesName(localPart, jane)).toBe(expected);
  });
});

describe('canReplaceClassification', () => {
  it('never replaces a published address', () => {
    for (const incoming of [
      'published',
      'decoded_published',
      'general_inbox',
      'invalid',
    ] as const) {
      expect(canReplaceClassification('published', incoming), incoming).toBe(false);
    }
  });

  it('upgrades to published when a later page shows the address in the clear', () => {
    expect(canReplaceClassification('decoded_published', 'published')).toBe(true);
    expect(canReplaceClassification('general_inbox', 'published')).toBe(true);
    expect(canReplaceClassification('invalid', 'published')).toBe(true);
  });

  it('changes nothing else', () => {
    // Not a ranking. Anything other than plain-text publication leaves the
    // stored classification alone, which is exactly what the SQL does.
    for (const stored of ['decoded_published', 'general_inbox', 'invalid'] as const) {
      for (const incoming of ['decoded_published', 'general_inbox', 'invalid'] as const) {
        expect(canReplaceClassification(stored, incoming), `${stored} <- ${incoming}`).toBe(false);
      }
    }
  });
});
