import type { CrawlPolicy } from '@pan/core';

/**
 * An authoritative published list of organizations, people or contacts.
 *
 * `verified` is false until a person has opened the URL and confirmed both that
 * it resolves and that the column mapping matches the real file. Nothing in this
 * repository guesses at a government file's shape, and the importer refuses to
 * run against an unverified source.
 */
export interface OfficialSource {
  key: string;
  name: string;
  url: string;
  /** Reference code from the taxonomy, e.g. `csv`, `open_data_portal`, `api`. */
  sourceTypeCode: string;
  format: 'csv' | 'tsv' | 'xlsx' | 'json' | 'html' | 'api' | 'pdf';
  provides: string;
  verified: boolean;
  verificationNote: string;
}

/** Maps columns in an official file to our fields. Confirmed per source, never guessed. */
export interface ColumnMapping {
  organizationName?: string;
  organizationId?: string;
  organizationTypeCode?: string;
  parentOrganizationName?: string;
  parentOrganizationId?: string;
  countyName?: string;
  cityName?: string;
  stateCode?: string;
  websiteUrl?: string;
  /** Sector-specific columns, keyed by the extension field they populate. */
  extensionColumns?: Readonly<Record<string, string>>;
}

export interface IdentifierMapping {
  /** Reference code from the taxonomy, e.g. `nces_district_id`, `cgac_agency_code`. */
  identifierSystemCode: string;
  /** What the issuing authority calls it, e.g. "County-District Number". */
  officialName: string;
  pattern: string;
  description: string;
}

export interface SeedOrganization {
  name: string;
  organizationTypeCode: string;
  /** Name of the organization above it, when there is one. Federal bodies often have none. */
  parentName: string | null;
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

/**
 * Configuration for one jurisdiction and, optionally, one sector within it.
 *
 * Deliberately not "state config": a federal agency has a jurisdiction and no
 * state, a county has one inside a state, and a school district has one that
 * matches neither cleanly. The unit of onboarding is a jurisdiction plus the
 * sector being worked, which is why Texas education and Texas state government
 * are two configurations rather than one.
 */
export interface JurisdictionConfig {
  /** Stable key, e.g. `texas-education`, `us-federal`, `harris-county-tx`. */
  key: string;
  name: string;
  /** Reference code from the taxonomy, e.g. `federal`, `state`, `county`, `education`. */
  governmentLevelCode: string;
  /** Sectors this configuration covers. */
  sectorCodes: readonly string[];
  /** The jurisdiction row this configuration creates or attaches to. */
  jurisdiction: {
    code: string;
    name: string;
    /** Postal code of the state this sits in, when it sits in one. Null for federal. */
    stateCode: string | null;
    /** FIPS code of the covering area, when there is one. */
    areaFipsCode: string | null;
  };
  officialSources: readonly OfficialSource[];
  columnMappings: Readonly<Record<string, ColumnMapping>>;
  identifierMappings: readonly IdentifierMapping[];
  /** Source spellings that map to a canonical geographic area name. */
  areaAliases: Readonly<Record<string, string>>;
  /** Expected count of the primary sub-area, used as a coverage check after import. */
  expectedAreaCount: number | null;
  seedOrganizations: readonly SeedOrganization[];
  crawlPolicy: Partial<CrawlPolicy>;
  domainDenyList: readonly { domain: string; reason: string }[];
  extraUrlExclusions: readonly string[];
  notes: readonly string[];
}
