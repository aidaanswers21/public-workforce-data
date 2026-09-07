import type { JurisdictionConfig } from '@public-workforce/jurisdiction-kit';

const CENSUS_GOVERNMENT_UNITS_SOURCE = {
  key: 'census-government-units-2025',
  name: 'Census Bureau 2025 Government Units Survey universe file',
  url: 'https://www.census.gov/data/datasets/2025/econ/gus/public-use-files.html',
  sourceTypeCode: 'bulk_dataset',
  format: 'xlsx' as const,
  provides:
    'Official government-unit identifiers, classifications, locations, population, and published websites.',
  verified: false,
  verificationNote:
    'The 2025 release and workbook structure were inspected locally on 2026-09-07. Record production approval before importing or collecting from it.',
};

function censusScope(
  key: string,
  name: string,
  governmentLevelCode: string,
  sectorCode: string,
): JurisdictionConfig {
  return {
    key,
    name,
    governmentLevelCode,
    sectorCodes: [sectorCode],
    jurisdiction: {
      code: key,
      name,
      stateCode: null,
      areaFipsCode: null,
    },
    officialSources: [CENSUS_GOVERNMENT_UNITS_SOURCE],
    columnMappings: {},
    identifierMappings: [
      {
        identifierSystemCode: 'census_government_id',
        officialName: 'Census Government Unit ID',
        pattern: '^\\d+$',
        description: 'Stable identifier published in the Government Units Survey universe file.',
      },
    ],
    areaAliases: {},
    expectedAreaCount: null,
    seedOrganizations: [],
    crawlPolicy: {
      requestDelayMs: 2_000,
      maxPagesPerDomain: 100,
      maxConcurrencyPerDomain: 1,
    },
    domainDenyList: [],
    extraUrlExclusions: [],
    notes: [
      'This configuration scopes organizations already loaded from the official bulk release.',
      'A state selection narrows locations within the national source instead of changing the source.',
      'Directory collection remains separately gated by source policy and an explicitly approved batch.',
    ],
  };
}

export const nationalSpineJurisdictions: readonly JurisdictionConfig[] = [
  censusScope(
    'us-census-county-general-government',
    'National county governments',
    'county',
    'general_government',
  ),
  censusScope(
    'us-census-municipal-general-government',
    'National municipal governments',
    'municipal',
    'general_government',
  ),
  censusScope(
    'us-census-township-general-government',
    'National township governments',
    'township',
    'general_government',
  ),
  censusScope(
    'us-census-special-district-education',
    'National independent education districts',
    'special_district',
    'education',
  ),
  censusScope(
    'us-census-county-education',
    'County-operated education systems',
    'county',
    'education',
  ),
  censusScope(
    'us-census-municipal-education',
    'Municipal education systems',
    'municipal',
    'education',
  ),
  censusScope(
    'us-census-township-education',
    'Township education systems',
    'township',
    'education',
  ),
  censusScope(
    'us-census-state-education',
    'State-operated education systems',
    'state',
    'education',
  ),
];
