import type { CrawlPolicy } from '@pan/core';
import type { SourceType } from '@pan/shared-types';

/**
 * An authoritative published list of institutions for a state.
 *
 * `verified` is false until a human has opened the URL and confirmed both that
 * it resolves and that the column mapping below matches the real file. Nothing
 * in this repository guesses at a government file's shape, and the importer
 * refuses to run against an unverified source unless explicitly overridden.
 */
export interface OfficialSource {
  key: string;
  name: string;
  url: string;
  sourceType: SourceType;
  format: 'csv' | 'tsv' | 'xlsx' | 'json' | 'html' | 'api';
  /** What this source provides, in one line. */
  provides: string;
  verified: boolean;
  /** What a human must check before marking this verified. */
  verificationNote: string;
}

/** Maps columns in an official file to our fields. Confirmed per source, never guessed. */
export interface ColumnMapping {
  districtName?: string;
  districtId?: string;
  schoolName?: string;
  schoolId?: string;
  countyName?: string;
  websiteUrl?: string;
  schoolLevel?: string;
  lowGrade?: string;
  highGrade?: string;
  ncesId?: string;
}

export interface IdentifierMapping {
  /** Our field, e.g. `stateAgencyId`. */
  field: 'ncesId' | 'stateAgencyId' | 'federalEin';
  /** What the state calls it, e.g. "County-District Number". */
  officialName: string;
  /** Expected shape, used to reject obviously wrong values on import. */
  pattern: string;
  description: string;
}

export interface SeedInstitution {
  districtName: string;
  countyName: string | null;
  websiteUrl: string | null;
  /**
   * True when official identifiers are still missing.
   *
   * A seed row exists so local development has something to run against. It is
   * never a substitute for the importer, and coverage reporting counts it
   * separately.
   */
  identifiersPending: boolean;
}

export interface StateConfig {
  code: string;
  name: string;
  fipsCode: string;
  configKey: string;
  /** Where the authoritative institution lists come from. */
  officialSources: readonly OfficialSource[];
  columnMappings: Readonly<Record<string, ColumnMapping>>;
  identifierMappings: readonly IdentifierMapping[];
  /** Source spellings that map to a canonical county name. */
  countyAliases: Readonly<Record<string, string>>;
  /** Expected county count, used as a coverage check after import. */
  expectedCountyCount: number | null;
  seedInstitutions: readonly SeedInstitution[];
  /** Per-state crawl tuning. Everything unset falls back to the platform default. */
  crawlPolicy: Partial<CrawlPolicy>;
  /** Domains never to crawl for this state, with a reason. */
  domainDenyList: readonly { domain: string; reason: string }[];
  /** Extra URL patterns to exclude beyond the platform defaults. */
  extraUrlExclusions: readonly string[];
  notes: readonly string[];
}
