import { describe, expect, it } from 'vitest';
import { looksLikeTitle, normalizeTitle, type TitleRuleSet } from './titles.js';

/**
 * A deliberately tiny rule set.
 *
 * These tests cover how rules are applied, not what any vertical's rules say.
 * The real composed taxonomy is exercised in `tests/title-taxonomy.test.ts`,
 * which keeps this file free of any knowledge about public-sector job titles.
 */
const RULES: TitleRuleSet = {
  rules: [
    {
      test: /\bdeputy-director\b/,
      roleCategoryCode: 'deputy_executive',
      seniorityCode: 'director',
      source: 'test',
    },
    {
      test: /\bdirector\b/,
      roleCategoryCode: 'department_head',
      seniorityCode: 'director',
      confidence: 0.7,
      source: 'test',
    },
    {
      test: /\bclerk\b/,
      roleCategoryCode: 'administrative_support',
      seniorityCode: 'support',
      source: 'test',
    },
  ],
  abbreviations: [{ pattern: /\bdir\b\.?/gi, expansion: 'Director' }],
  seniorityModifiers: [{ test: /\bsenior\b/, seniorityCode: 'senior' }],
  fallbackRoleCategoryCode: 'other',
  unknownRoleCategoryCode: 'unknown',
  jobFamilyForRole: (code) => (code === 'administrative_support' ? 'administration' : 'leadership'),
  specialtyPatterns: [/\bTraffic\b/],
  version: 'test-1',
};

describe('normalizeTitle', () => {
  it('returns unknown for a missing title rather than guessing', () => {
    const result = normalizeTitle(null, RULES);
    expect(result.roleCategoryCode).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.titlePublished).toBeNull();
  });

  it('preserves the published title exactly', () => {
    expect(normalizeTitle('  DEPUTY   DIRECTOR ', RULES).titlePublished).toBe('DEPUTY DIRECTOR');
  });

  it('applies the first matching rule, so specific beats general', () => {
    expect(normalizeTitle('Deputy Director', RULES).roleCategoryCode).toBe('deputy_executive');
    expect(normalizeTitle('Director of Finance', RULES).roleCategoryCode).toBe('department_head');
  });

  it('expands abbreviations and de-shouts before matching', () => {
    const result = normalizeTitle('DEP. DIR.', RULES);
    expect(result.titleNormalized).toContain('Director');
  });

  it('resolves the job family through the supplied mapping', () => {
    expect(normalizeTitle('Clerk', RULES).jobFamilyCode).toBe('administration');
  });

  it('lets a seniority modifier override the matched rule', () => {
    expect(normalizeTitle('Senior Clerk', RULES).seniorityCode).toBe('senior');
  });

  it('records which pack produced the match, for audit', () => {
    expect(normalizeTitle('Clerk', RULES).ruleSource).toBe('test');
    expect(normalizeTitle('Something Unmatched', RULES).ruleSource).toBeNull();
  });

  it('records the taxonomy version so a re-run is comparable', () => {
    expect(normalizeTitle('Clerk', RULES).taxonomyVersion).toBe('test-1');
    expect(normalizeTitle('Clerk', RULES).method).toBe('rule_table');
  });

  it('keeps an unmatched title as the fallback with low confidence, never dropping it', () => {
    const result = normalizeTitle('Wombat Wrangler', RULES);
    expect(result.roleCategoryCode).toBe('other');
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.titleNormalized).toBe('Wombat Wrangler');
  });

  it('extracts a specialty when the title carries one', () => {
    expect(normalizeTitle('Traffic Engineer', RULES).specialty).toBe('Traffic');
  });

  it('carries no built-in vocabulary: an empty rule set matches nothing', () => {
    const empty: TitleRuleSet = {
      ...RULES,
      rules: [],
      abbreviations: [],
      specialtyPatterns: [],
    };
    expect(normalizeTitle('Director', empty).roleCategoryCode).toBe('other');
    expect(normalizeTitle('Traffic Engineer', empty).specialty).toBeNull();
  });
});

describe('looksLikeTitle', () => {
  it('recognizes table header labels', () => {
    expect(looksLikeTitle('Name', RULES)).toBe(true);
    expect(looksLikeTitle('Organization', RULES)).toBe(true);
  });

  it('recognizes a title covered by the supplied rules', () => {
    expect(looksLikeTitle('Director', RULES)).toBe(true);
  });

  it('does not mistake a person name for a title', () => {
    expect(looksLikeTitle('Jane Smith', RULES)).toBe(false);
  });
});
