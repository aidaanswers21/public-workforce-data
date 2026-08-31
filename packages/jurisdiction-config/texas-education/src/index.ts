import type { ColumnMapping, JurisdictionConfig } from '@public-workforce/jurisdiction-kit';

/**
 * Texas public education, the first jurisdiction onboarded.
 *
 * Named for a jurisdiction and a sector rather than for a state, because that is
 * the real unit of onboarding: Texas state government and Texas public education
 * publish different sources, use different identifiers and answer to different
 * bodies. A second configuration would cover Texas state agencies without
 * touching this one.
 *
 * Two rules govern this file. Nothing here is invented: any value a person has
 * not confirmed against the real published source is marked unverified, and the
 * importer refuses to run against an unverified source. And nothing here is
 * code: onboarding the next jurisdiction means writing another object like this,
 * not touching the crawler, the adapters or the schema.
 */

const TEA_ORGANIZATION_REFERENCE: ColumnMapping = {
  // Column names must be confirmed against the downloaded file before the first
  // import. They are the field names as commonly published, not a guess at a
  // file this repository has read: outbound access to tea.texas.gov is not
  // available from the environment this was built in.
  organizationName: 'DISTNAME',
  organizationId: 'DISTRICT',
  countyName: 'CNTYNAME',
};

const TEA_CAMPUS_REFERENCE: ColumnMapping = {
  organizationName: 'CAMPNAME',
  organizationId: 'CAMPUS',
  parentOrganizationName: 'DISTNAME',
  parentOrganizationId: 'DISTRICT',
  countyName: 'CNTYNAME',
  extensionColumns: {
    schoolType: 'GRDTYPE',
    lowGrade: 'GRDSPAN_LOW',
    highGrade: 'GRDSPAN_HIGH',
  },
};

const NCES_CCD: ColumnMapping = {
  organizationName: 'LEA_NAME',
  organizationId: 'LEAID',
  countyName: 'LCOUNTY',
};

export const texasEducationJurisdiction: JurisdictionConfig = {
  key: 'texas-education',
  name: 'Texas public education',
  // Texas independent school districts are political subdivisions of the state
  // with their own boards and taxing authority, which makes them special
  // districts. The sector is what they do; the level is what they are. See
  // docs/DATA_MODEL.md on why `education` is never a government level.
  governmentLevelCode: 'special_district',
  sectorCodes: ['education'],

  jurisdiction: {
    code: 'us-tx-education',
    name: 'Texas public education',
    stateCode: 'TX',
    areaFipsCode: '48',
  },

  officialSources: [
    {
      key: 'tea-district-reference',
      name: 'Texas Education Agency district reference file',
      url: 'https://tea.texas.gov/reports-and-data/school-data/download-data',
      sourceTypeCode: 'csv',
      format: 'csv',
      provides:
        'The authoritative list of Texas public school districts with county and district number.',
      verified: false,
      verificationNote:
        'Open the TEA download page, locate the current district reference file, record its direct URL and confirm the column names in columnMappings.teaOrganizationReference.',
    },
    {
      key: 'tea-campus-reference',
      name: 'Texas Education Agency campus reference file',
      url: 'https://tea.texas.gov/reports-and-data/school-data/download-data',
      sourceTypeCode: 'csv',
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
      sourceTypeCode: 'html_directory',
      format: 'html',
      provides: 'District and campus contact details, including official website addresses.',
      verified: false,
      verificationNote:
        'Confirm the current AskTED entry point and whether it offers a bulk download. If it does not, directory discovery runs from organization websites instead and this source is documentation only.',
    },
    {
      key: 'nces-ccd',
      name: 'NCES Common Core of Data',
      url: 'https://nces.ed.gov/ccd/files.asp',
      sourceTypeCode: 'bulk_dataset',
      format: 'csv',
      provides: 'Federal NCES identifiers, used to cross-reference the state lists.',
      verified: false,
      verificationNote:
        'Choose the current school year directory files, record their direct URLs and confirm the column names in columnMappings.ncesCcd.',
    },
  ],

  columnMappings: {
    teaOrganizationReference: TEA_ORGANIZATION_REFERENCE,
    teaCampusReference: TEA_CAMPUS_REFERENCE,
    ncesCcd: NCES_CCD,
  },

  identifierMappings: [
    {
      identifierSystemCode: 'state_education_org_id',
      officialName: 'County-District Number (CDN)',
      pattern: '^\\d{6}$',
      description:
        'Texas identifies a district by a six digit county-district number. Confirm the width and any leading-zero handling against the downloaded file before the first import.',
    },
    {
      identifierSystemCode: 'nces_district_id',
      officialName: 'NCES LEAID',
      pattern: '^\\d{7}$',
      description: 'Federal local education agency identifier from the Common Core of Data.',
    },
    {
      identifierSystemCode: 'nces_school_id',
      officialName: 'NCES NCESSCH',
      pattern: '^\\d{12}$',
      description: 'Federal school identifier from the Common Core of Data.',
    },
  ],

  // County spellings that vary between published files. Partial by design: it
  // grows as the importer reports unmatched areas, and the expected count below
  // is the check that catches what is still missing.
  areaAliases: {
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

  expectedAreaCount: 254,

  // Local development seeds only. Official identifiers and websites come from
  // the importer and from directory discovery; inventing either here would put
  // unverified values into the database with no source document behind them.
  seedOrganizations: [
    {
      name: 'Houston Independent School District',
      organizationTypeCode: 'school_district',
      parentName: null,
      countyName: 'Harris',
      websiteUrl: null,
      identifiersPending: true,
    },
    {
      name: 'Dallas Independent School District',
      organizationTypeCode: 'school_district',
      parentName: null,
      countyName: 'Dallas',
      websiteUrl: null,
      identifiersPending: true,
    },
    {
      name: 'Austin Independent School District',
      organizationTypeCode: 'school_district',
      parentName: null,
      countyName: 'Travis',
      websiteUrl: null,
      identifiersPending: true,
    },
    {
      name: 'Northside Independent School District',
      organizationTypeCode: 'school_district',
      parentName: null,
      countyName: 'Bexar',
      websiteUrl: null,
      identifiersPending: true,
    },
    {
      name: 'Cypress-Fairbanks Independent School District',
      organizationTypeCode: 'school_district',
      parentName: null,
      countyName: 'Harris',
      websiteUrl: null,
      identifiersPending: true,
    },
  ],

  crawlPolicy: {
    // Roughly 1,200 districts and 9,000 campuses, so a run touches many domains
    // lightly rather than one domain heavily.
    requestDelayMs: 2000,
    maxPagesPerDomain: 150,
    maxConcurrencyPerDomain: 1,
  },

  domainDenyList: [],

  extraUrlExclusions: [
    '/(taa|tapr|txschools|accountability)(/|$)',
    '/(board-?docs|boarddocs)(/|$)',
  ],

  notes: [
    'No official source is marked verified yet. The importer refuses to run until a person confirms each URL and column mapping.',
    'AskTED is the most likely source of official website addresses. If it offers no bulk export, discovery falls back to crawling organization homepages for directory links.',
    'The area alias table is partial. After the first import, compare the distinct county count against expectedAreaCount and add whatever is missing.',
    'Texas state government is a separate jurisdiction configuration, not part of this one.',
  ],
};

export default texasEducationJurisdiction;
