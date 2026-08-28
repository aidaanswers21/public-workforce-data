import { describe, expect, it } from 'vitest';
import { parsePersonName } from '../normalize/names.js';
import { nameTokens } from '../normalize/names.js';
import {
  generateCandidate,
  inferenceConfidence,
  learnDomainPatterns,
  patternsMatching,
  renderPattern,
  type PublishedNamePair,
} from './patterns.js';

const DOMAIN = 'sample-isd.example.org';

function pair(name: string, localPart: string, domain = DOMAIN): PublishedNamePair {
  return { parsed: parsePersonName(name), address: `${localPart}@${domain}` };
}

describe('renderPattern', () => {
  const tokens = nameTokens(parsePersonName('Jane Marie Smith'));

  it.each([
    ['{first}.{last}', 'jane.smith'],
    ['{f}{last}', 'jsmith'],
    ['{first}{l}', 'janes'],
    ['{last}{f}', 'smithj'],
    ['{f}{m}{last}', 'jmsmith'],
    ['{first}_{last}', 'jane_smith'],
  ])('renders %s as %s', (pattern, expected) => {
    expect(renderPattern(pattern, tokens)).toBe(expected);
  });

  it('returns null rather than a partial string when a token is missing', () => {
    const noMiddle = nameTokens(parsePersonName('Jane Smith'));
    expect(renderPattern('{f}{m}{last}', noMiddle)).toBeNull();
  });
});

describe('patternsMatching', () => {
  it('finds every pattern consistent with an observed local part', () => {
    expect(patternsMatching('jane.smith', parsePersonName('Jane Smith'))).toContain(
      '{first}.{last}',
    );
  });

  it('returns nothing when the local part encodes a different name', () => {
    expect(patternsMatching('bob.jones', parsePersonName('Jane Smith'))).toHaveLength(0);
  });
});

describe('learnDomainPatterns', () => {
  it('learns the dominant convention from published addresses', () => {
    const pairs = [
      pair('Jane Smith', 'jane.smith'),
      pair('Wei Chen', 'wei.chen'),
      pair('Ana Rivera', 'ana.rivera'),
      pair('Thomas Berg', 'thomas.berg'),
    ];
    const [learned] = learnDomainPatterns(DOMAIN, pairs);
    expect(learned?.pattern).toBe('{first}.{last}');
    expect(learned?.supportCount).toBe(4);
    expect(learned?.consistency).toBe(1);
    expect(learned?.supportingExamples).toContain('jane.smith@sample-isd.example.org');
  });

  it('refuses to learn from too few examples', () => {
    const pairs = [pair('Jane Smith', 'jane.smith'), pair('Wei Chen', 'wei.chen')];
    expect(learnDomainPatterns(DOMAIN, pairs)).toHaveLength(0);
  });

  it('refuses to learn when the domain is inconsistent', () => {
    const pairs = [
      pair('Jane Smith', 'jane.smith'),
      pair('Wei Chen', 'wei.chen'),
      pair('Ana Rivera', 'ana.rivera'),
      pair('Thomas Berg', 'tberg'),
      pair('Linh Nguyen', 'nguyenl'),
      pair('Rosa Delgado', 'rdelgado'),
    ];
    expect(learnDomainPatterns(DOMAIN, pairs)).toHaveLength(0);
  });

  it('ignores addresses from other domains', () => {
    const pairs = [
      pair('Jane Smith', 'jane.smith'),
      pair('Wei Chen', 'wei.chen'),
      pair('Ana Rivera', 'ana.rivera'),
      pair('Other Person', 'other.person', 'different.example.net'),
    ];
    const [learned] = learnDomainPatterns(DOMAIN, pairs);
    expect(learned?.supportCount).toBe(3);
    expect(learned?.conflictCount).toBe(0);
  });
});

describe('generateCandidate', () => {
  const pairs = [
    pair('Jane Smith', 'jane.smith'),
    pair('Wei Chen', 'wei.chen'),
    pair('Ana Rivera', 'ana.rivera'),
  ];
  const learned = learnDomainPatterns(DOMAIN, pairs)[0];

  it('produces an address plus the evidence behind it', () => {
    const candidate = generateCandidate(parsePersonName('Omar Farouk'), learned!);
    expect(candidate?.address).toBe('omar.farouk@sample-isd.example.org');
    expect(candidate?.pattern).toBe('{first}.{last}');
    expect(candidate?.evidence.supportCount).toBe(3);
    expect(candidate?.evidence.supportingExamples.length).toBeGreaterThan(0);
  });

  it('returns null when the name cannot fill the pattern', () => {
    expect(generateCandidate(parsePersonName('Prince'), learned!)).toBeNull();
  });

  it('never claims certainty', () => {
    const candidate = generateCandidate(parsePersonName('Omar Farouk'), learned!);
    expect(candidate?.confidence).toBeLessThanOrEqual(0.95);
    expect(candidate?.confidence).toBeGreaterThan(0);
  });
});

describe('inferenceConfidence', () => {
  it('rises with support and falls with inconsistency', () => {
    const strong = inferenceConfidence({
      pattern: '{first}.{last}',
      supportingExamples: [],
      supportCount: 20,
      conflictCount: 0,
      consistency: 1,
    });
    const weak = inferenceConfidence({
      pattern: '{first}.{last}',
      supportingExamples: [],
      supportCount: 3,
      conflictCount: 1,
      consistency: 0.75,
    });
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeLessThanOrEqual(0.95);
  });
});
