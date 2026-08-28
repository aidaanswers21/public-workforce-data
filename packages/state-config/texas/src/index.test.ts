import { describe, expect, it } from 'vitest';
import { StateRegistry, validateStateConfig } from '@pan/state-kit';
import { texasStateConfig } from './index.js';

describe('texas state config', () => {
  it('has no validation errors', () => {
    const errors = validateStateConfig(texasStateConfig).filter(
      (issue) => issue.severity === 'error',
    );
    expect(errors).toEqual([]);
  });

  it('warns that its sources are not yet human-verified', () => {
    const warnings = validateStateConfig(texasStateConfig).filter(
      (issue) => issue.severity === 'warning',
    );
    expect(warnings.some((issue) => issue.problem.includes('not yet verified'))).toBe(true);
  });

  it('declares the state identifier Texas actually uses', () => {
    const cdn = texasStateConfig.identifierMappings.find(
      (mapping) => mapping.field === 'stateAgencyId',
    );
    expect(cdn?.officialName).toContain('County-District Number');
    expect(new RegExp(cdn!.pattern).test('101912')).toBe(true);
    expect(new RegExp(cdn!.pattern).test('12345')).toBe(false);
  });

  it('expects the real number of Texas counties', () => {
    expect(texasStateConfig.expectedCountyCount).toBe(254);
  });

  it('normalizes the county spellings that vary between published files', () => {
    expect(texasStateConfig.countyAliases['de witt']).toBe('DeWitt');
    expect(texasStateConfig.countyAliases['mclennan']).toBe('McLennan');
  });

  it('does not claim identifiers or websites it has not imported', () => {
    for (const seed of texasStateConfig.seedInstitutions) {
      expect(seed.identifiersPending).toBe(true);
      expect(seed.websiteUrl).toBeNull();
    }
  });

  it('registers without any code change to the registry', () => {
    const registry = new StateRegistry().register(texasStateConfig);
    expect(registry.codes()).toEqual(['TX']);
    expect(registry.get('tx').name).toBe('Texas');
  });
});
