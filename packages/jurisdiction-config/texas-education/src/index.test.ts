import { describe, expect, it } from 'vitest';
import { JurisdictionRegistry, validateJurisdictionConfig } from '@pan/jurisdiction-kit';
import { Taxonomy } from '@pan/taxonomy';
import { educationSectorPack } from '@pan/sector-education';
import { texasEducationJurisdiction as config } from './index.js';

const TAXONOMY = new Taxonomy([educationSectorPack]);

describe('the Texas public education jurisdiction', () => {
  it('has no validation errors against the composed taxonomy', () => {
    const errors = validateJurisdictionConfig(config, TAXONOMY).filter(
      (issue) => issue.severity === 'error',
    );
    expect(errors).toEqual([]);
  });

  it('warns that its sources are not yet human-verified', () => {
    const warnings = validateJurisdictionConfig(config, TAXONOMY).filter(
      (issue) => issue.severity === 'warning',
    );
    expect(warnings.some((issue) => issue.problem.includes('not yet verified'))).toBe(true);
  });

  it('claims no source a person has confirmed', () => {
    // The importer refuses to run against an unverified source, so this is the
    // assertion that keeps an unread government file out of the database.
    expect(config.officialSources.every((source) => !source.verified)).toBe(true);
    expect(config.officialSources.every((source) => source.verificationNote.length > 0)).toBe(true);
  });

  it('is a jurisdiction and a sector, not a state', () => {
    expect(config.key).toBe('texas-education');
    expect(config.governmentLevelCode).toBe('education');
    expect(config.sectorCodes).toEqual(['education']);
    // It sits in a state without being one, which is what lets a second
    // configuration cover Texas state agencies without touching this file.
    expect(config.jurisdiction.stateCode).toBe('TX');
  });

  it('declares the identifier Texas actually uses, alongside the federal ones', () => {
    const cdn = config.identifierMappings.find(
      (mapping) => mapping.identifierSystemCode === 'state_education_org_id',
    );
    expect(cdn?.officialName).toContain('County-District Number');
    expect(new RegExp(cdn!.pattern).test('101912')).toBe(true);
    expect(new RegExp(cdn!.pattern).test('12345')).toBe(false);

    // Several systems at once, because an organization carries a state
    // identifier and a federal one rather than choosing between them.
    expect(config.identifierMappings.map((mapping) => mapping.identifierSystemCode)).toEqual([
      'state_education_org_id',
      'nces_district_id',
      'nces_school_id',
    ]);
  });

  it('names only identifier systems the taxonomy knows', () => {
    const known = new Set(TAXONOMY.identifierSystems.map((system) => system.code));
    for (const mapping of config.identifierMappings) {
      expect(known.has(mapping.identifierSystemCode)).toBe(true);
    }
  });

  it('expects the real number of Texas counties', () => {
    expect(config.expectedAreaCount).toBe(254);
  });

  it('normalizes the county spellings that vary between published files', () => {
    expect(config.areaAliases['de witt']).toBe('DeWitt');
    expect(config.areaAliases['mclennan']).toBe('McLennan');
  });

  it('does not claim identifiers or websites it has not imported', () => {
    for (const seed of config.seedOrganizations) {
      expect(seed.identifiersPending).toBe(true);
      expect(seed.websiteUrl).toBeNull();
    }
  });

  it('seeds only organization types the composed taxonomy knows', () => {
    const known = new Set(TAXONOMY.organizationTypes.map((type) => type.code));
    for (const seed of config.seedOrganizations) {
      expect(known.has(seed.organizationTypeCode)).toBe(true);
    }
  });

  it('registers without any code change to the registry', () => {
    const registry = new JurisdictionRegistry().register(config);
    expect(registry.keys()).toEqual(['texas-education']);
    expect(registry.get('texas-education').name).toBe('Texas public education');
    expect(registry.atLevel('education')).toHaveLength(1);
    expect(registry.atLevel('federal')).toHaveLength(0);
  });
});
