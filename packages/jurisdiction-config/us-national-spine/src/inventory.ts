export interface OrganizationSpineInventorySource {
  key: string;
  name: string;
  catalogUrl: string;
  records: number;
  publishedWebsites: number;
  missingWebsites: number;
}

export interface OrganizationSpineInventoryGeography {
  code: string;
  name: string;
  records: number;
}

export interface OrganizationSpineInventoryState {
  code: string;
  name: string;
}

export interface OrganizationSpineInventory {
  generatedAt: string;
  sourceRows: number;
  geographicAreas: number;
  relationships: number;
  publishedWebsiteValues: number;
  missingWebsiteQueue: number;
  exactWebsiteOverlays: number;
  classificationWork: number;
  reconciliationRequired: number;
  sources: readonly OrganizationSpineInventorySource[];
  geographies: readonly OrganizationSpineInventoryGeography[];
  states: readonly OrganizationSpineInventoryState[];
  notes: readonly string[];
}

/**
 * Reproducible counts from the locally preserved organizer manifest.
 *
 * This is an inventory of staged artifacts, not a claim that the rows are in
 * the hosted database. The console displays the hosted counts beside these so
 * the handoff from organized files to canonical records cannot be ambiguous.
 */
export const nationalOrganizationSpineInventory: OrganizationSpineInventory = {
  generatedAt: '2026-09-07T20:15:23.692Z',
  sourceRows: 231_016,
  geographicAreas: 85_415,
  relationships: 107_981,
  publishedWebsiteValues: 138_205,
  missingWebsiteQueue: 90_003,
  exactWebsiteOverlays: 394,
  classificationWork: 167_561,
  reconciliationRequired: 472,
  sources: [
    {
      key: 'texas-askted-site-2026',
      name: 'Texas Education Agency AskTED site data',
      catalogUrl: 'https://tea.texas.gov/askted',
      records: 10_898,
      publishedWebsites: 8_689,
      missingWebsites: 2_209,
    },
    {
      key: 'nces-ccd-lea-directory-2024-25',
      name: 'NCES Common Core of Data LEA directory, 2024-25',
      catalogUrl: 'https://nces.ed.gov/ccd/files.asp',
      records: 19_630,
      publishedWebsites: 17_212,
      missingWebsites: 2_418,
    },
    {
      key: 'nces-ccd-school-directory-2024-25',
      name: 'NCES Common Core of Data school directory, 2024-25',
      catalogUrl: 'https://nces.ed.gov/ccd/files.asp',
      records: 102_178,
      publishedWebsites: 70_274,
      missingWebsites: 31_904,
    },
    {
      key: 'census-government-units-2025:general_purpose',
      name: 'Census 2025 government units, general purpose',
      catalogUrl: 'https://www.census.gov/data/datasets/2025/econ/gus/public-use-files.html',
      records: 38_704,
      publishedWebsites: 16_190,
      missingWebsites: 22_514,
    },
    {
      key: 'census-government-units-2025:special_district',
      name: 'Census 2025 government units, special districts',
      catalogUrl: 'https://www.census.gov/data/datasets/2025/econ/gus/public-use-files.html',
      records: 40_199,
      publishedWebsites: 11_743,
      missingWebsites: 28_456,
    },
    {
      key: 'census-government-units-2025:independent_school_district',
      name: 'Census 2025 government units, independent school districts',
      catalogUrl: 'https://www.census.gov/data/datasets/2025/econ/gus/public-use-files.html',
      records: 12_535,
      publishedWebsites: 11_724,
      missingWebsites: 811,
    },
    {
      key: 'census-government-units-2025:dependent_school_system',
      name: 'Census 2025 government units, dependent school systems',
      catalogUrl: 'https://www.census.gov/data/datasets/2025/econ/gus/public-use-files.html',
      records: 1_318,
      publishedWebsites: 867,
      missingWebsites: 451,
    },
    {
      key: 'census-government-units-2025:public_pension_system',
      name: 'Census 2025 government units, public pension systems',
      catalogUrl: 'https://www.census.gov/data/datasets/2025/econ/gus/public-use-files.html',
      records: 4_485,
      publishedWebsites: 642,
      missingWebsites: 3_843,
    },
    {
      key: 'usagov-agency-index-2026',
      name: 'USA.gov A-Z agency index',
      catalogUrl: 'https://www.usa.gov/agency-index',
      records: 597,
      publishedWebsites: 597,
      missingWebsites: 0,
    },
    {
      key: 'federal-register-agencies-api-2026',
      name: 'Federal Register agencies API',
      catalogUrl: 'https://www.federalregister.gov/developers/documentation/api/v1',
      records: 472,
      publishedWebsites: 267,
      missingWebsites: 205,
    },
  ],
  geographies: [
    { code: 'state', name: 'States and District of Columbia', records: 51 },
    { code: 'territory', name: 'Territories in the published file', records: 1 },
    { code: 'county', name: 'Counties and equivalents', records: 3_222 },
    { code: 'county_subdivision', name: 'County subdivisions', records: 36_427 },
    { code: 'census_place', name: 'Census places', records: 32_350 },
    {
      code: 'elementary_school_district_area',
      name: 'Elementary school district areas',
      records: 1_971,
    },
    {
      code: 'secondary_school_district_area',
      name: 'Secondary school district areas',
      records: 478,
    },
    {
      code: 'unified_school_district_area',
      name: 'Unified school district areas',
      records: 10_863,
    },
    {
      code: 'school_district_administrative_area',
      name: 'School district administrative areas',
      records: 52,
    },
  ],
  states: [
    ['AL', 'Alabama'],
    ['AK', 'Alaska'],
    ['AZ', 'Arizona'],
    ['AR', 'Arkansas'],
    ['CA', 'California'],
    ['CO', 'Colorado'],
    ['CT', 'Connecticut'],
    ['DE', 'Delaware'],
    ['DC', 'District of Columbia'],
    ['FL', 'Florida'],
    ['GA', 'Georgia'],
    ['HI', 'Hawaii'],
    ['ID', 'Idaho'],
    ['IL', 'Illinois'],
    ['IN', 'Indiana'],
    ['IA', 'Iowa'],
    ['KS', 'Kansas'],
    ['KY', 'Kentucky'],
    ['LA', 'Louisiana'],
    ['ME', 'Maine'],
    ['MD', 'Maryland'],
    ['MA', 'Massachusetts'],
    ['MI', 'Michigan'],
    ['MN', 'Minnesota'],
    ['MS', 'Mississippi'],
    ['MO', 'Missouri'],
    ['MT', 'Montana'],
    ['NE', 'Nebraska'],
    ['NV', 'Nevada'],
    ['NH', 'New Hampshire'],
    ['NJ', 'New Jersey'],
    ['NM', 'New Mexico'],
    ['NY', 'New York'],
    ['NC', 'North Carolina'],
    ['ND', 'North Dakota'],
    ['OH', 'Ohio'],
    ['OK', 'Oklahoma'],
    ['OR', 'Oregon'],
    ['PA', 'Pennsylvania'],
    ['RI', 'Rhode Island'],
    ['SC', 'South Carolina'],
    ['SD', 'South Dakota'],
    ['TN', 'Tennessee'],
    ['TX', 'Texas'],
    ['UT', 'Utah'],
    ['VT', 'Vermont'],
    ['VA', 'Virginia'],
    ['WA', 'Washington'],
    ['WV', 'West Virginia'],
    ['WI', 'Wisconsin'],
    ['WY', 'Wyoming'],
  ].map(([code, name]) => ({ code: code as string, name: name as string })),
  notes: [
    'Source rows remain separate until exact identifiers establish a canonical match.',
    'Published website values are retained as source evidence; missing websites enter a separate resolution queue.',
    'Incomplete government-level classifications remain visible work instead of being guessed.',
    'No person-level or student-level fields are present in these organization artifacts.',
  ],
};
