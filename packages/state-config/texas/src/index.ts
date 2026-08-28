import type { ColumnMapping, StateConfig } from '@pan/state-kit';

/**
 * Texas, the first state onboarded.
 *
 * Two rules govern this file. Nothing here is invented: any value a human has
 * not confirmed against the real published source is marked unverified, and the
 * importer refuses to run against an unverified source. And nothing here is
 * code: adding the next state means writing another object like this one, not
 * touching the crawler, the adapters or the schema.
 */

const TEA_DISTRICT_REFERENCE: ColumnMapping = {
  // Column names must be confirmed against the downloaded file before the first
  // import. They are the TEA field names as commonly published, not a guess at
  // a file this repository has read: outbound access to tea.texas.gov is not
  // available from the build environment.
  districtName: 'DISTNAME',
  districtId: 'DISTRICT',
  countyName: 'CNTYNAME',
};

const TEA_CAMPUS_REFERENCE: ColumnMapping = {
  districtName: 'DISTNAME',
  districtId: 'DISTRICT',
  schoolName: 'CAMPNAME',
  schoolId: 'CAMPUS',
  countyName: 'CNTYNAME',
  schoolLevel: 'GRDTYPE',
  lowGrade: 'GRDSPAN_LOW',
  highGrade: 'GRDSPAN_HIGH',
};

const NCES_CCD: ColumnMapping = {
  districtName: 'LEA_NAME',
  ncesId: 'LEAID',
  schoolName: 'SCH_NAME',
  schoolId: 'NCESSCH',
  countyName: 'LCOUNTY',
};

export const texasStateConfig: StateConfig = {
  code: 'TX',
  name: 'Texas',
  fipsCode: '48',
  configKey: 'texas',

  officialSources: [
    {
      key: 'tea-district-reference',
      name: 'Texas Education Agency district reference file',
      url: 'https://tea.texas.gov/reports-and-data/school-data/download-data',
      sourceType: 'state_agency',
      format: 'csv',
      provides:
        'The authoritative list of Texas public school districts with county and district number.',
      verified: false,
      verificationNote:
        'Open the TEA download page, locate the current district reference file, record its direct URL and confirm the column names in columnMappings.teaDistrictReference.',
    },
    {
      key: 'tea-campus-reference',
      name: 'Texas Education Agency campus reference file',
      url: 'https://tea.texas.gov/reports-and-data/school-data/download-data',
      sourceType: 'state_agency',
      format: 'csv',
      provides:
        'The authoritative list of Texas public school campuses with grade span and district number.',
      verified: false,
      verificationNote:
        'Same page as the district reference file. Confirm the campus file URL and the column names in columnMappings.teaCampusReference.',
    },
    {
      key: 'askted',
      name: 'AskTED, the Texas school directory',
      url: 'https://tea.texas.gov/texas-schools/general-information/askted',
      sourceType: 'state_agency',
      format: 'html',
      provides: 'District and campus contact details, including official website addresses.',
      verified: false,
      verificationNote:
        'Confirm the current AskTED entry point and whether it offers a bulk download. If it does not, directory discovery runs from district websites instead and this source is documentation only.',
    },
    {
      key: 'nces-ccd',
      name: 'NCES Common Core of Data',
      url: 'https://nces.ed.gov/ccd/files.asp',
      sourceType: 'state_agency',
      format: 'csv',
      provides: 'Federal NCES identifiers, used to cross-reference the TEA lists.',
      verified: false,
      verificationNote:
        'Choose the current school year directory files, record their direct URLs and confirm the column names in columnMappings.ncesCcd.',
    },
  ],

  columnMappings: {
    teaDistrictReference: TEA_DISTRICT_REFERENCE,
    teaCampusReference: TEA_CAMPUS_REFERENCE,
    ncesCcd: NCES_CCD,
  },

  identifierMappings: [
    {
      field: 'stateAgencyId',
      officialName: 'County-District Number (CDN)',
      pattern: '^\\d{6}$',
      description:
        'Texas identifies a district by a six digit county-district number. Confirm the width and any leading-zero handling against the downloaded file before the first import.',
    },
    {
      field: 'ncesId',
      officialName: 'NCES LEAID / NCESSCH',
      pattern: '^\\d{7}(\\d{5})?$',
      description:
        'Federal identifiers from the Common Core of Data. Seven digits for a district (LEAID), twelve for a campus (NCESSCH).',
    },
  ],

  // Texas county spellings that vary between published files. This table is
  // partial by design and grows as the importer reports unmatched counties;
  // the expected count below is the check that catches what is still missing.
  countyAliases: {
    'de witt': 'DeWitt',
    dewitt: 'DeWitt',
    mclennan: 'McLennan',
    'mc lennan': 'McLennan',
    mcculloch: 'McCulloch',
    'mc culloch': 'McCulloch',
    mcmullen: 'McMullen',
    'mc mullen': 'McMullen',
    'la salle': 'La Salle',
    lasalle: 'La Salle',
    'val verde': 'Val Verde',
  },

  expectedCountyCount: 254,

  // Local development seeds only. Official identifiers and websites come from
  // the importer and from directory discovery; inventing them here would put
  // unverified values into the database with no source page behind them.
  seedInstitutions: [
    {
      districtName: 'Houston Independent School District',
      countyName: 'Harris',
      websiteUrl: null,
      identifiersPending: true,
    },
    {
      districtName: 'Dallas Independent School District',
      countyName: 'Dallas',
      websiteUrl: null,
      identifiersPending: true,
    },
    {
      districtName: 'Austin Independent School District',
      countyName: 'Travis',
      websiteUrl: null,
      identifiersPending: true,
    },
    {
      districtName: 'Northside Independent School District',
      countyName: 'Bexar',
      websiteUrl: null,
      identifiersPending: true,
    },
    {
      districtName: 'Cypress-Fairbanks Independent School District',
      countyName: 'Harris',
      websiteUrl: null,
      identifiersPending: true,
    },
  ],

  crawlPolicy: {
    // Texas has roughly 1,200 districts and 9,000 campuses, so a run touches
    // many domains lightly rather than one domain heavily.
    requestDelayMs: 2000,
    maxPagesPerDomain: 150,
    maxConcurrencyPerDomain: 1,
  },

  domainDenyList: [],

  extraUrlExclusions: [
    // Texas districts commonly publish these under district sites and they are
    // never staff directories.
    '/(taa|tapr|txschools|accountability)(/|$)',
    '/(board-?docs|boarddocs)(/|$)',
  ],

  notes: [
    'No official source is marked verified yet. The importer will refuse to run until a human confirms each URL and column mapping.',
    'AskTED is the most likely source of official district and campus website addresses. If it offers no bulk export, discovery falls back to crawling district homepages for directory links.',
    'The county alias table is partial. After the first import, compare the distinct county count against expectedCountyCount and add whatever is missing.',
  ],
};

export default texasStateConfig;
