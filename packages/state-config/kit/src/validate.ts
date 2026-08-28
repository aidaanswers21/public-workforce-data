import type { StateConfig } from './types.js';

export interface ConfigIssue {
  field: string;
  problem: string;
  severity: 'error' | 'warning';
}

const CODE_PATTERN = /^[A-Z]{2}$/;
const FIPS_PATTERN = /^\d{2}$/;

/**
 * Validate a state configuration before it is used.
 *
 * Errors block onboarding; warnings are the things a state is expected to carry
 * during its early phases (unverified sources, pending identifiers) and are
 * surfaced in the coverage report rather than hidden.
 */
export function validateStateConfig(config: StateConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const error = (field: string, problem: string): void => {
    issues.push({ field, problem, severity: 'error' });
  };
  const warn = (field: string, problem: string): void => {
    issues.push({ field, problem, severity: 'warning' });
  };

  if (!CODE_PATTERN.test(config.code)) error('code', 'must be a two letter upper case code');
  if (!FIPS_PATTERN.test(config.fipsCode)) error('fipsCode', 'must be a two digit FIPS code');
  if (config.configKey.trim().length === 0) error('configKey', 'must not be empty');
  if (config.officialSources.length === 0)
    error('officialSources', 'at least one official source is required');

  for (const source of config.officialSources) {
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:') error(`officialSources.${source.key}`, 'must use https');
    } catch {
      error(`officialSources.${source.key}`, `is not a valid url: ${source.url}`);
    }
    if (!source.verified) {
      warn(
        `officialSources.${source.key}`,
        'not yet verified by a human; the importer will refuse to run against it',
      );
    }
  }

  if (config.identifierMappings.length === 0) {
    warn('identifierMappings', 'no official identifier mapping declared');
  }
  for (const mapping of config.identifierMappings) {
    try {
      new RegExp(mapping.pattern);
    } catch {
      error(
        `identifierMappings.${mapping.field}`,
        `pattern is not a valid regular expression: ${mapping.pattern}`,
      );
    }
  }

  for (const pattern of config.extraUrlExclusions) {
    try {
      new RegExp(pattern);
    } catch {
      error('extraUrlExclusions', `not a valid regular expression: ${pattern}`);
    }
  }

  const pending = config.seedInstitutions.filter((seed) => seed.identifiersPending).length;
  if (pending > 0) {
    warn(
      'seedInstitutions',
      `${pending} seed rows still lack official identifiers; run the importer before relying on coverage`,
    );
  }

  return issues;
}

export function assertStateConfigValid(config: StateConfig): void {
  const errors = validateStateConfig(config).filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `state config ${config.code} is invalid:\n${errors.map((issue) => `  ${issue.field}: ${issue.problem}`).join('\n')}`,
    );
  }
}
