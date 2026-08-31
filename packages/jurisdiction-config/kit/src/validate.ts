import type { Taxonomy } from '@public-workforce/taxonomy';
import type { JurisdictionConfig } from './types.js';

export interface ConfigIssue {
  field: string;
  problem: string;
  severity: 'error' | 'warning';
}

/**
 * Validate a jurisdiction configuration before it is used.
 *
 * Every taxonomy code it names must resolve, which turns a typo into a start-up
 * failure rather than rows that quietly land in the `other` bucket. Errors block
 * onboarding; warnings are the things a jurisdiction is expected to carry early
 * on, and are surfaced in coverage reporting rather than hidden.
 */
export function validateJurisdictionConfig(
  config: JurisdictionConfig,
  taxonomy: Taxonomy,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const error = (field: string, problem: string): void => {
    issues.push({ field, problem, severity: 'error' });
  };
  const warn = (field: string, problem: string): void => {
    issues.push({ field, problem, severity: 'warning' });
  };

  if (!/^[a-z0-9-]+$/.test(config.key)) error('key', 'must be lower case with hyphens');
  if (config.name.trim().length === 0) error('name', 'must not be empty');

  const levels = new Set(taxonomy.governmentLevels.map((row) => row.code));
  if (!levels.has(config.governmentLevelCode)) {
    error('governmentLevelCode', `"${config.governmentLevelCode}" is not a known government level`);
  }

  const sectors = new Set(taxonomy.sectors.map((row) => row.code));
  if (config.sectorCodes.length === 0) error('sectorCodes', 'at least one sector is required');
  for (const code of config.sectorCodes) {
    if (!sectors.has(code)) error('sectorCodes', `"${code}" is not a known sector`);
  }

  if (config.jurisdiction.code.trim().length === 0) error('jurisdiction.code', 'must not be empty');
  if (config.governmentLevelCode === 'federal' && config.jurisdiction.stateCode !== null) {
    error('jurisdiction.stateCode', 'a federal jurisdiction must not name a state as its parent');
  }

  if (config.officialSources.length === 0) {
    error('officialSources', 'at least one official source is required');
  }
  const sourceTypes = new Set(taxonomy.sourceTypes.map((row) => row.code));
  for (const source of config.officialSources) {
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:') error(`officialSources.${source.key}`, 'must use https');
    } catch {
      error(`officialSources.${source.key}`, `is not a valid url: ${source.url}`);
    }
    if (!sourceTypes.has(source.sourceTypeCode)) {
      error(
        `officialSources.${source.key}`,
        `"${source.sourceTypeCode}" is not a known source type`,
      );
    }
    if (!source.verified) {
      warn(
        `officialSources.${source.key}`,
        'not yet verified by a person; the importer will refuse to run against it',
      );
    }
  }

  const identifierSystems = new Set(taxonomy.identifierSystems.map((row) => row.code));
  if (config.identifierMappings.length === 0) {
    warn('identifierMappings', 'no official identifier mapping declared');
  }
  for (const mapping of config.identifierMappings) {
    if (!identifierSystems.has(mapping.identifierSystemCode)) {
      error(
        'identifierMappings',
        `"${mapping.identifierSystemCode}" is not a known identifier system`,
      );
    }
    try {
      new RegExp(mapping.pattern);
    } catch {
      error('identifierMappings', `pattern is not a valid regular expression: ${mapping.pattern}`);
    }
  }

  const organizationTypes = new Set(taxonomy.organizationTypes.map((row) => row.code));
  for (const seed of config.seedOrganizations) {
    if (!organizationTypes.has(seed.organizationTypeCode)) {
      error('seedOrganizations', `"${seed.organizationTypeCode}" is not a known organization type`);
    }
  }

  for (const pattern of config.extraUrlExclusions) {
    try {
      new RegExp(pattern);
    } catch {
      error('extraUrlExclusions', `not a valid regular expression: ${pattern}`);
    }
  }

  const pending = config.seedOrganizations.filter((seed) => seed.identifiersPending).length;
  if (pending > 0) {
    warn(
      'seedOrganizations',
      `${pending} seed rows still lack official identifiers; run the importer before relying on coverage`,
    );
  }

  return issues;
}

export function assertJurisdictionConfigValid(
  config: JurisdictionConfig,
  taxonomy: Taxonomy,
): void {
  const errors = validateJurisdictionConfig(config, taxonomy).filter(
    (issue) => issue.severity === 'error',
  );
  if (errors.length > 0) {
    throw new Error(
      `jurisdiction config ${config.key} is invalid:\n${errors.map((issue) => `  ${issue.field}: ${issue.problem}`).join('\n')}`,
    );
  }
}
