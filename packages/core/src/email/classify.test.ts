import { describe, expect, it } from 'vitest';
import { parsePersonName } from '../normalize/names.js';
import { canReplaceClassification, classifyEmail, localPartMatchesName } from './classify.js';

const jane = parsePersonName('Jane Smith');

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
    'info@sample-isd.example.org',
    'office@sample-isd.example.org',
    'frontoffice@sample-isd.example.org',
    'webmaster@sample-isd.example.org',
    'attendance@sample-isd.example.org',
    'noreply@sample-isd.example.org',
  ])('classifies %s as a general inbox', (address) => {
    const result = classifyEmail({ address, obfuscation: 'none', origin: 'observed' });
    expect(result.classification).toBe('general_inbox');
    expect(result.isGeneralInbox).toBe(true);
  });

  it('does not treat a person address as a shared inbox just because it starts with a role word', () => {
    const result = classifyEmail({
      address: 'hrobinson@sample-isd.example.org',
      obfuscation: 'none',
      origin: 'observed',
      personName: parsePersonName('Helen Robinson'),
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
  it('never lets an inferred candidate overwrite a published address', () => {
    expect(canReplaceClassification('published', 'inferred_candidate')).toBe(false);
    expect(canReplaceClassification('decoded_published', 'inferred_candidate')).toBe(false);
  });

  it('lets a published address replace a decoded or inferred one', () => {
    expect(canReplaceClassification('decoded_published', 'published')).toBe(true);
    expect(canReplaceClassification('inferred_candidate', 'published')).toBe(true);
  });

  it('does not replace a published address with another published one', () => {
    expect(canReplaceClassification('published', 'published')).toBe(false);
  });
});
