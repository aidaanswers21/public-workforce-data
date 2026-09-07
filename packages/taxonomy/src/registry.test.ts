import { describe, expect, it } from 'vitest';
import { Taxonomy, baseTaxonomy, type SectorPack } from './registry.js';
import { GOVERNMENT_LEVELS } from './reference/government-levels.js';
import { SECTORS } from './reference/sectors.js';

const REQUIRED_LEVELS = [
  'federal',
  'state',
  'county',
  'municipal',
  'township',
  'special_district',
  'tribal',
  'other_public_authority',
];

const ANY_SCOPE = { sectorCodes: null, governmentLevelCodes: null } as const;

describe('reference data', () => {
  it('covers every required level of government', () => {
    const codes = GOVERNMENT_LEVELS.map((row) => row.code);
    for (const level of REQUIRED_LEVELS) expect(codes).toContain(level);
  });

  it('has no education government level, because education is a sector', () => {
    // Government level and sector are orthogonal. An independent school
    // district is a special district doing education work; a city-run school is
    // a municipal body doing the same work. An `education` level would force
    // both to claim a level neither has.
    expect(GOVERNMENT_LEVELS.map((row) => row.code)).not.toContain('education');
    expect(SECTORS.map((row) => row.code)).toContain('education');
  });

  it('has a unique, stable code for every row', () => {
    const taxonomy = baseTaxonomy();
    for (const rows of [
      taxonomy.organizationTypes,
      taxonomy.roleCategories,
      taxonomy.identifierSystems,
      taxonomy.extractionMethods,
      taxonomy.obfuscationKinds,
    ]) {
      const codes = rows.map((row) => row.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it('ships neutral organization types at every level of government', () => {
    const taxonomy = baseTaxonomy();
    for (const level of REQUIRED_LEVELS) {
      expect(
        taxonomy.organizationTypesDefaultingToLevel(level).length,
        `no type for ${level}`,
      ).toBeGreaterThan(0);
    }
  });

  it('carries no education-sector types until a sector supplies them', () => {
    expect(baseTaxonomy().organizationType('school_district')).toBeNull();
  });

  it('holds extraction methods and obfuscation kinds as reference data', () => {
    // Both grow with every new source format, so neither is an enum and neither
    // needs a migration to extend.
    const taxonomy = baseTaxonomy();
    expect(taxonomy.extractionMethods.map((row) => row.code)).toContain('html_table');
    expect(taxonomy.obfuscationKinds.map((row) => row.code)).toContain('cloudflare_cfemail');
  });
});

describe('organization types are defaults, not constraints', () => {
  it('leaves the level null where the real world varies', () => {
    // A school district is an independent special district in most states and a
    // department of a city or county in others. A default would be wrong for
    // one of them, so there is none.
    const taxonomy = new Taxonomy([educationLikePack]);
    expect(
      taxonomy.organizationType('test_school_district')?.defaultGovernmentLevelCode,
    ).toBeNull();
    expect(taxonomy.organizationType('test_school_district')?.defaultSectorCode).toBe('education');
  });

  it('never forces a type into one level, so the same type spans levels', () => {
    const taxonomy = new Taxonomy([educationLikePack]);
    const type = taxonomy.organizationType('test_school_district');
    expect(type).not.toBeNull();
    // Nothing in the taxonomy pairs a type with a level, which is what lets the
    // database record an independent district and a city-run one as the same
    // type at different levels. The database half is asserted in
    // packages/database/src/repositories/repositories.test.ts.
    expect(Object.keys(type ?? {})).not.toContain('governmentLevelCode');
  });
});

const educationLikePack: SectorPack = {
  key: 'test-education',
  displayName: 'Test education',
  description: 'An education-shaped vertical invented inside this test file.',
  appliesTo: { sectorCodes: ['education'], governmentLevelCodes: null },
  organizationTypes: [
    {
      code: 'test_school_district',
      name: 'Test school district',
      description: 'Exists only in this test.',
      defaultGovernmentLevelCode: null,
      defaultSectorCode: 'education',
      typicallySubordinate: false,
    },
  ],
};

describe('sector composition', () => {
  const pack: SectorPack = {
    key: 'test-vertical',
    displayName: 'Test vertical',
    description: 'A vertical invented inside this test file.',
    appliesTo: { sectorCodes: ['other'], governmentLevelCodes: null },
    organizationTypes: [
      {
        code: 'test_authority',
        name: 'Test authority',
        description: 'Exists only in this test.',
        defaultGovernmentLevelCode: 'other_public_authority',
        defaultSectorCode: 'other',
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

  it('exposes sector-owned organization explorer presets without interpreting them', () => {
    const configured: SectorPack = {
      ...pack,
      explorerPresets: [
        {
          key: 'test-organizations',
          name: 'Test organizations',
          singularName: 'Test organization',
          description: 'Fixture source records.',
          organizationTypeCodes: ['test_authority'],
          sectorCodes: ['other'],
          attributeColumns: [
            { key: 'publishedCount', label: 'Published count', format: 'integer' },
          ],
        },
      ],
    };

    expect(new Taxonomy([configured]).explorerPresets).toEqual(configured.explorerPresets);
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
});

describe('packs may not silently overwrite each other', () => {
  const base: SectorPack = {
    key: 'first',
    displayName: 'First',
    description: 'defines a role category',
    appliesTo: ANY_SCOPE,
    jobFamilies: [{ code: 'shared_family', name: 'Shared', description: 'x' }],
    roleCategories: [
      { code: 'shared_role', name: 'First name', description: 'x', jobFamilyCode: 'shared_family' },
    ],
  };

  it('refuses a second pack redefining the first pack’s role category', () => {
    const second: SectorPack = {
      key: 'second',
      displayName: 'Second',
      description: 'redefines the first pack’s role category',
      appliesTo: ANY_SCOPE,
      roleCategories: [
        {
          code: 'shared_role',
          name: 'Second name',
          description: 'x',
          jobFamilyCode: 'shared_family',
        },
      ],
    };
    expect(() => new Taxonomy([base, second])).toThrow(
      /pack "second" redefines role category "shared_role", already defined by pack "first"/,
    );
  });

  it('refuses a pack redefining a base organization type', () => {
    expect(
      () =>
        new Taxonomy([
          {
            key: 'shadow',
            displayName: 'Shadow',
            description: 'redefines a base type',
            appliesTo: ANY_SCOPE,
            organizationTypes: [
              {
                code: 'county_department',
                name: 'Not a county department',
                description: 'x',
                defaultGovernmentLevelCode: 'county',
                defaultSectorCode: 'other',
                typicallySubordinate: false,
              },
            ],
          },
        ]),
    ).toThrow(
      /redefines organization type "county_department", already defined by the neutral base/,
    );
  });

  it('refuses a pack redefining a base identifier system', () => {
    expect(
      () =>
        new Taxonomy([
          {
            key: 'shadow',
            displayName: 'Shadow',
            description: 'redefines a base identifier system',
            appliesTo: ANY_SCOPE,
            identifierSystems: [
              {
                code: 'fips_state',
                name: 'Not FIPS',
                description: 'x',
                appliesTo: 'geographic_area',
                pattern: null,
                authority: 'nobody',
              },
            ],
          },
        ]),
    ).toThrow(/redefines identifier system "fips_state"/);
  });

  it('refuses a pack that defines the same code twice', () => {
    expect(
      () =>
        new Taxonomy([
          {
            key: 'sloppy',
            displayName: 'Sloppy',
            description: 'defines one code twice',
            appliesTo: ANY_SCOPE,
            jobFamilies: [
              { code: 'dup', name: 'One', description: 'x' },
              { code: 'dup', name: 'Two', description: 'x' },
            ],
          },
        ]),
    ).toThrow(/defines job family "dup" twice/);
  });

  it('allows a redefinition the pack declares as an override', () => {
    const second: SectorPack = {
      key: 'second',
      displayName: 'Second',
      description: 'deliberately replaces the first pack’s role category',
      appliesTo: ANY_SCOPE,
      overrides: ['shared_role'],
      roleCategories: [
        {
          code: 'shared_role',
          name: 'Second name',
          description: 'x',
          jobFamilyCode: 'shared_family',
        },
      ],
    };
    const taxonomy = new Taxonomy([base, second]);
    expect(taxonomy.roleCategory('shared_role')?.name).toBe('Second name');
  });

  it('reports every collision at once rather than the first', () => {
    const second: SectorPack = {
      key: 'second',
      displayName: 'Second',
      description: 'clashes twice over',
      appliesTo: ANY_SCOPE,
      jobFamilies: [{ code: 'shared_family', name: 'Clash', description: 'x' }],
      roleCategories: [
        { code: 'shared_role', name: 'Clash', description: 'x', jobFamilyCode: 'shared_family' },
      ],
    };
    try {
      new Taxonomy([base, second]);
      expect.unreachable('expected a collision');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('job family "shared_family"');
      expect(message).toContain('role category "shared_role"');
    }
  });

  it('refuses a pack that tries to define a government level or a sector', () => {
    // These are the axes every other code is described against, so only the
    // neutral base may define them.
    const rogue = {
      key: 'rogue',
      displayName: 'Rogue',
      description: 'invents a level',
      appliesTo: ANY_SCOPE,
      governmentLevels: [{ code: 'atlantis', name: 'Atlantis', description: 'x' }],
    } as unknown as SectorPack;
    expect(() => new Taxonomy([rogue])).toThrow(
      /contributes governmentLevels, which only the neutral base may define/,
    );
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
            appliesTo: ANY_SCOPE,
            organizationTypes: [
              {
                code: 'broken_type',
                name: 'Broken',
                description: 'x',
                defaultGovernmentLevelCode: 'atlantis',
                defaultSectorCode: 'other',
                typicallySubordinate: false,
              },
            ],
          },
        ]),
    ).toThrow(/unknown government level/);
  });

  it('rejects a pack scoped to a sector that does not exist', () => {
    expect(
      () =>
        new Taxonomy([
          {
            key: 'broken',
            displayName: 'Broken',
            description: 'scoped to nothing real',
            appliesTo: { sectorCodes: ['underwater_basket_weaving'], governmentLevelCodes: null },
          },
        ]),
    ).toThrow(/scoped to unknown sector/);
  });

  it('rejects a title rule naming an unknown role category', () => {
    expect(
      () =>
        new Taxonomy([
          {
            key: 'broken',
            displayName: 'Broken',
            description: 'names a role that does not exist',
            appliesTo: ANY_SCOPE,
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
            appliesTo: ANY_SCOPE,
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
