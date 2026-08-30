import { describe, expect, it } from 'vitest';
import { Taxonomy, baseTaxonomy, type SectorPack } from './registry.js';
import { GOVERNMENT_LEVELS } from './reference/government-levels.js';

const REQUIRED_LEVELS = [
  'federal',
  'state',
  'county',
  'municipal',
  'township',
  'special_district',
  'tribal',
  'education',
  'other_public_authority',
];

describe('reference data', () => {
  it('covers every required level of government', () => {
    const codes = GOVERNMENT_LEVELS.map((row) => row.code);
    for (const level of REQUIRED_LEVELS) expect(codes).toContain(level);
  });

  it('has a unique, stable code for every row', () => {
    const taxonomy = baseTaxonomy();
    for (const rows of [
      taxonomy.organizationTypes,
      taxonomy.roleCategories,
      taxonomy.identifierSystems,
    ]) {
      const codes = rows.map((row) => row.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it('ships neutral organization types at every level except education', () => {
    const taxonomy = baseTaxonomy();
    for (const level of REQUIRED_LEVELS.filter((code) => code !== 'education')) {
      expect(
        taxonomy.organizationTypesForLevel(level).length,
        `no type for ${level}`,
      ).toBeGreaterThan(0);
    }
  });

  it('carries no education-sector types until a sector supplies them', () => {
    expect(baseTaxonomy().organizationType('school_district')).toBeNull();
  });
});

describe('sector composition', () => {
  const pack: SectorPack = {
    key: 'test-vertical',
    displayName: 'Test vertical',
    description: 'A vertical invented inside this test file.',
    organizationTypes: [
      {
        code: 'test_authority',
        name: 'Test authority',
        description: 'Exists only in this test.',
        governmentLevelCode: 'other_public_authority',
        sectorCode: 'other',
        typicallySubordinate: false,
      },
    ],
    jobFamilies: [
      { code: 'test_family', name: 'Test family', description: 'Exists only in this test.' },
    ],
    roleCategories: [
      {
        code: 'test_role',
        name: 'Test role',
        description: 'Exists only in this test.',
        jobFamilyCode: 'test_family',
      },
    ],
    titleRules: [
      { test: /\btest-officer\b/, roleCategoryCode: 'test_role', seniorityCode: 'staff' },
    ],
    vocabulary: { headingTerms: ['test roster'], titleIndicatorTerms: ['testofficer'] },
  };

  it('adds a type, a role and a rule with no migration and no core change', () => {
    const taxonomy = new Taxonomy([pack]);
    expect(taxonomy.organizationType('test_authority')?.name).toBe('Test authority');
    expect(taxonomy.roleCategory('test_role')?.jobFamilyCode).toBe('test_family');
    expect(taxonomy.titleRules.some((rule) => rule.roleCategoryCode === 'test_role')).toBe(true);
  });

  it('merges vocabulary onto the base rather than replacing it', () => {
    const taxonomy = new Taxonomy([pack]);
    expect(taxonomy.vocabulary.headingTerms).toContain('test roster');
    expect(taxonomy.vocabulary.headingTerms).toContain('staff');
  });

  it('tries sector rules before the neutral base', () => {
    const taxonomy = new Taxonomy([pack]);
    const sectorRuleIndex = taxonomy.titleRules.findIndex(
      (rule) => rule.source === 'test-vertical',
    );
    const baseRuleIndex = taxonomy.titleRules.findIndex((rule) => rule.source === 'base');
    expect(sectorRuleIndex).toBeLessThan(baseRuleIndex);
  });

  it('records which pack contributed each rule', () => {
    const taxonomy = new Taxonomy([pack]);
    expect(taxonomy.titleRules.find((rule) => rule.roleCategoryCode === 'test_role')?.source).toBe(
      'test-vertical',
    );
  });

  it('de-duplicates vocabulary contributions', () => {
    const taxonomy = new Taxonomy([pack, { ...pack, key: 'second' }]);
    const occurrences = taxonomy.vocabulary.headingTerms.filter((term) => term === 'test roster');
    expect(occurrences).toHaveLength(1);
  });
});

describe('coherence', () => {
  it('rejects a pack naming an unknown government level', () => {
    expect(
      () =>
        new Taxonomy([
          {
            key: 'broken',
            displayName: 'Broken',
            description: 'names a level that does not exist',
            organizationTypes: [
              {
                code: 'broken_type',
                name: 'Broken',
                description: 'x',
                governmentLevelCode: 'atlantis',
                sectorCode: 'other',
                typicallySubordinate: false,
              },
            ],
          },
        ]),
    ).toThrow(/unknown government level/);
  });

  it('rejects a title rule naming an unknown role category', () => {
    expect(
      () =>
        new Taxonomy([
          {
            key: 'broken',
            displayName: 'Broken',
            description: 'names a role that does not exist',
            titleRules: [{ test: /\bx\b/, roleCategoryCode: 'not_a_role', seniorityCode: 'staff' }],
          },
        ]),
    ).toThrow(/unknown role category/);
  });

  it('rejects a role category naming an unknown job family', () => {
    expect(
      () =>
        new Taxonomy([
          {
            key: 'broken',
            displayName: 'Broken',
            description: 'names a family that does not exist',
            roleCategories: [
              {
                code: 'orphan_role',
                name: 'Orphan',
                description: 'x',
                jobFamilyCode: 'no_such_family',
              },
            ],
          },
        ]),
    ).toThrow(/unknown job family/);
  });
});
