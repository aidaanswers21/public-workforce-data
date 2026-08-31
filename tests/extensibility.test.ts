import { afterEach, describe, expect, it } from 'vitest';
import type {
  AdapterContext,
  DetectionContext,
  DetectionResult,
  DirectoryAdapter,
  DiscoveredDirectory,
  ExtractedPersonRecord,
  FetchedPage,
  ListingExtraction,
  PaginationPlan,
  Uuid,
} from '@public-workforce/shared-types';
import {
  AdapterRegistry,
  buildPersonRecord,
  checkAdapterContract,
  fixturePage,
} from '@public-workforce/adapter-kit';
import {
  CrawlEngine,
  OrganizationHierarchy,
  PermissiveRobotsProvider,
  SuppressionIndex,
  parsePersonName,
  personIdentityKey,
  withPolicyDefaults,
} from '@public-workforce/core';
import { createSilentLogger } from '@public-workforce/observability';
import {
  DelimitedOrganizationImporter,
  JurisdictionRegistry,
  validateJurisdictionConfig,
  type JurisdictionConfig,
} from '@public-workforce/jurisdiction-kit';
import {
  ComplianceRepository,
  IngestionRepository,
  OrganizationRepository,
  QueryRepository,
  TestDatabase,
} from '@public-workforce/database';
import { educationSectorPack } from '@public-workforce/sector-education';
import { federalGovernmentSectorPack } from '@public-workforce/sector-federal';
import { stateLocalGovernmentSectorPack } from '@public-workforce/sector-state-local';
import { buildAdapterRegistry, buildJurisdictionRegistry } from '@public-workforce/crawler-worker';
import { MapFetcher } from './support/fetchers.js';
import { allSectorsTaxonomy } from './support/taxonomy.js';

const TAXONOMY = allSectorsTaxonomy();
const VOCABULARY = TAXONOMY.vocabulary;
const SECTORS = [educationSectorPack, stateLocalGovernmentSectorPack, federalGovernmentSectorPack];
const AT = '2026-06-01T00:00:00.000Z';
const EFFECTIVE_FROM = '2026-01-01T00:00:00.000Z';
const PURPOSE = 'internal-review';

/* -------------------------------------------------------------------------- */
/* A public-sector world, built entirely inside this file                      */
/* -------------------------------------------------------------------------- */

interface World {
  database: TestDatabase;
  organizations: OrganizationRepository;
  ingestion: IngestionRepository;
  compliance: ComplianceRepository;
  queries: QueryRepository;
  documentId: Uuid;
  documentVersionId: Uuid;
  org: (input: {
    name: string;
    typeCode: string;
    levelCode: string;
    sectorCode?: string;
    jurisdictionId?: Uuid;
    parentOrganizationId?: Uuid;
  }) => Promise<Uuid>;
  jurisdiction: (code: string, name: string, levelCode: string, areaId?: Uuid) => Promise<Uuid>;
  area: (typeCode: string, name: string, stateCode?: string, parentId?: Uuid) => Promise<Uuid>;
  partOf: (parentId: Uuid, childId: Uuid, from?: string, to?: string | null) => Promise<void>;
  location: (organizationId: Uuid, city: string, stateCode: string, areaId?: Uuid) => Promise<Uuid>;
  person: (input: {
    organizationId: Uuid;
    name: string;
    title: string;
    address: string;
    dutyLocationId?: Uuid | null;
    roleCategoryCode?: string;
  }) => Promise<Uuid>;
}

let open: TestDatabase | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

async function world(): Promise<World> {
  const database = await TestDatabase.create({ sectors: SECTORS });
  open = database;
  const organizations = new OrganizationRepository(database);
  const ingestion = new IngestionRepository(database);

  const document = await ingestion.recordSourceDocument({
    url: 'https://example.gov/source',
    urlCanonical: 'https://example.gov/source',
    urlHash: 'world-source',
    domain: 'example.gov',
    sourceTypeCode: 'html_directory',
    httpStatus: 200,
    contentHash: 'c1',
    contentType: 'text/html',
    storageKey: null,
    robotsAllowed: true,
    robotsPolicyNote: null,
    crawlRunId: null,
    retrievedAt: AT,
  });
  const documentId = document.documentId;
  const documentVersionId = document.versionId;

  let counter = 0;
  const common = {
    sourceDocumentId: documentId,
    extractionMethod: 'manual' as const,
    confidence: 1,
    observedAt: AT,
  };

  return {
    database,
    organizations,
    ingestion,
    compliance: new ComplianceRepository(database),
    queries: new QueryRepository(database),
    documentId,
    documentVersionId,
    area: async (typeCode, name, stateCode, parentId) =>
      organizations.upsertGeographicArea({
        areaTypeCode: typeCode,
        name,
        nameNormalized: `${name.toLowerCase()}-${typeCode}`,
        ...(stateCode === undefined ? {} : { stateCode }),
        ...(parentId === undefined ? {} : { parentAreaId: parentId }),
      }),
    jurisdiction: async (code, name, levelCode, areaId) =>
      organizations.upsertJurisdiction({
        code,
        name,
        governmentLevelCode: levelCode,
        ...(areaId === undefined ? {} : { geographicAreaId: areaId }),
      }),
    org: async (input) => {
      counter += 1;
      const created = await organizations.upsertOrganization({
        organizationTypeCode: input.typeCode,
        governmentLevelCode: input.levelCode,
        sectorCode: input.sectorCode ?? 'general_government',
        ...(input.jurisdictionId === undefined ? {} : { jurisdictionId: input.jurisdictionId }),
        ...(input.parentOrganizationId === undefined
          ? {}
          : { parentOrganizationId: input.parentOrganizationId }),
        name: input.name,
        nameNormalized: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${counter}`,
        ...common,
      });
      return created.id;
    },
    partOf: async (parentId, childId, from = '2020-01-01', to = null) => {
      await organizations.upsertRelationship({
        parentOrganizationId: parentId,
        childOrganizationId: childId,
        relationshipTypeCode: 'part_of',
        effectiveFrom: from,
        effectiveTo: to,
        ...common,
      });
    },
    location: async (organizationId, city, stateCode, areaId) =>
      organizations.upsertLocation({
        organizationId,
        city,
        stateCode,
        ...(areaId === undefined ? {} : { geographicAreaId: areaId }),
        ...common,
      }),
    person: async (input) => {
      const parsed = parsePersonName(input.name);
      const result = await ingestion.ingestPerson({
        recordKey: `record:${input.organizationId}:${input.name}`,
        organizationId: input.organizationId,
        organizationalUnitId: null,
        dutyLocationId: input.dutyLocationId ?? null,
        fullNamePublished: input.name,
        nameParts: parsed,
        identityKey: personIdentityKey({ organizationId: input.organizationId, parsed }),
        titlePublished: input.title,
        titleNormalized: input.title,
        roleCategoryCode: input.roleCategoryCode ?? 'analyst',
        jobFamilyCode: 'research_policy',
        seniorityCode: 'staff',
        specialty: null,
        normalizationMethod: 'rule_table',
        normalizationRuleSource: 'base',
        taxonomyVersion: 'test',
        normalizationConfidence: 0.9,
        departmentPublished: null,
        emails: [
          {
            address: input.address,
            addressNormalized: input.address.toLowerCase(),
            domain: input.address.split('@')[1] as string,
            localPart: input.address.split('@')[0] as string,
            classification: 'published',
            obfuscation: 'none',
            sourceValue: input.address,
          },
        ],
        sourceDocumentId: documentId,
        crawlRunId: null,
        extractionMethod: 'html_table',
        confidence: 0.9,
        observedAt: AT,
      });
      return result.personId;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 1 to 5: every level of government, through unmodified neutral core          */
/* -------------------------------------------------------------------------- */

describe('the neutral model represents every level of government', () => {
  it('1: a public school under a school district', async () => {
    // An independent school district: education-sector work at the
    // special-district level. `education` is a sector, not a level, so the two
    // are recorded separately and neither is inferred from the other.
    const w = await world();
    const jurisdiction = await w.jurisdiction(
      'us-tx-education',
      'Texas public education',
      'special_district',
    );
    const district = await w.org({
      name: 'Sample Independent School District',
      typeCode: 'school_district',
      levelCode: 'special_district',
      sectorCode: 'education',
      jurisdictionId: jurisdiction,
    });
    const school = await w.org({
      name: 'Sample High School',
      typeCode: 'school',
      levelCode: 'special_district',
      sectorCode: 'education',
      jurisdictionId: jurisdiction,
      parentOrganizationId: district,
    });
    await w.partOf(district, school);
    await w.person({
      organizationId: school,
      name: 'Ana Rivera',
      title: 'Principal',
      address: 'ana.rivera@sample-isd.example.org',
    });

    expect(await w.organizations.ancestorsOf(school)).toEqual([district]);
    const rows = await w.queries.queryExportableRows(AT, PURPOSE);
    expect(rows[0]).toMatchObject({
      organizationName: 'Sample High School',
      parentOrganizationName: 'Sample Independent School District',
      governmentLevelCode: 'special_district',
      sectorCode: 'education',
    });
  });

  it('1b: the same district run by a city, at the municipal level', async () => {
    // The C9 ruling in one assertion: one organization type, two factually
    // supported government levels, both education-sector.
    const w = await world();
    const city = await w.jurisdiction('us-tx-springfield', 'Springfield', 'municipal');
    const cityRun = await w.org({
      name: 'Springfield City Schools',
      typeCode: 'school_district',
      levelCode: 'municipal',
      sectorCode: 'education',
      jurisdictionId: city,
    });
    const rows = await w.queries.queryExportableRows(AT, PURPOSE);
    expect(rows).toEqual([]);
    const stored = await w.database.query<{
      government_level_code: string;
      sector_code: string;
    }>('select government_level_code, sector_code from organizations where id = $1', [cityRun]);
    expect(stored.rows[0]).toEqual({
      government_level_code: 'municipal',
      sector_code: 'education',
    });
  });

  it('2: a state agency with a regional office', async () => {
    const w = await world();
    const area = await w.area('state', 'Colorado', 'CO');
    const jurisdiction = await w.jurisdiction('us-co', 'Colorado', 'state', area);
    const agency = await w.org({
      name: 'Department of Revenue',
      typeCode: 'state_agency',
      levelCode: 'state',
      jurisdictionId: jurisdiction,
    });
    const regional = await w.org({
      name: 'Western Regional Office',
      typeCode: 'state_regional_office',
      levelCode: 'state',
      jurisdictionId: jurisdiction,
    });
    await w.partOf(agency, regional);
    await w.person({
      organizationId: regional,
      name: 'Dana Ito',
      title: 'Field Supervisor',
      address: 'dana.ito@revenue.example.gov',
    });

    expect(await w.organizations.ancestorsOf(regional)).toEqual([agency]);
    const rows = await w.queries.queryExportableRows(AT, PURPOSE);
    expect(rows[0]?.jurisdictionName).toBe('Colorado');
  });

  it('3: a county with a subordinate department', async () => {
    const w = await world();
    const state = await w.area('state', 'Texas', 'TX');
    const county = await w.area('county', 'Harris', 'TX', state);
    const jurisdiction = await w.jurisdiction('us-tx-harris', 'Harris County', 'county', county);
    const government = await w.org({
      name: 'Harris County',
      typeCode: 'county_government',
      levelCode: 'county',
      jurisdictionId: jurisdiction,
    });
    const department = await w.org({
      name: 'Public Health Department',
      typeCode: 'county_department',
      levelCode: 'county',
      jurisdictionId: jurisdiction,
    });
    await w.partOf(government, department);
    await w.person({
      organizationId: department,
      name: 'Rosa Delgado',
      title: 'Epidemiologist',
      address: 'rosa.delgado@county.example.org',
    });

    expect(await w.organizations.ancestorsOf(department)).toEqual([government]);
    expect((await w.queries.queryExportableRows(AT, PURPOSE))[0]?.governmentLevelCode).toBe(
      'county',
    );
  });

  it('4: a municipality with a public safety department', async () => {
    const w = await world();
    const jurisdiction = await w.jurisdiction('us-tx-austin', 'City of Austin', 'municipal');
    const city = await w.org({
      name: 'City of Austin',
      typeCode: 'municipality',
      levelCode: 'municipal',
      jurisdictionId: jurisdiction,
    });
    const police = await w.org({
      name: 'Austin Police Department',
      typeCode: 'public_safety_agency',
      levelCode: 'municipal',
      sectorCode: 'public_safety',
      jurisdictionId: jurisdiction,
    });
    await w.partOf(city, police);
    await w.person({
      organizationId: police,
      name: 'Marcus Hall',
      title: 'Police Sergeant',
      address: 'marcus.hall@city.example.gov',
      roleCategoryCode: 'law_enforcement',
    });

    expect(await w.organizations.ancestorsOf(police)).toEqual([city]);
    expect((await w.queries.queryExportableRows(AT, PURPOSE))[0]?.sectorCode).toBe('public_safety');
  });

  it('5: a federal agency with offices in several states', async () => {
    const w = await world();
    const jurisdiction = await w.jurisdiction('us-federal', 'United States', 'federal');
    const agency = await w.org({
      name: 'Sample Federal Agency',
      typeCode: 'federal_agency',
      levelCode: 'federal',
      jurisdictionId: jurisdiction,
    });
    const bureau = await w.org({
      name: 'Sample Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
      jurisdictionId: jurisdiction,
    });
    await w.partOf(agency, bureau);

    const colorado = await w.area('state', 'Colorado', 'CO');
    const georgia = await w.area('state', 'Georgia', 'GA');
    const denver = await w.location(bureau, 'Denver', 'CO', colorado);
    const atlanta = await w.location(bureau, 'Atlanta', 'GA', georgia);

    await w.person({
      organizationId: bureau,
      name: 'Grace Hopper',
      title: 'Program Analyst',
      address: 'grace.hopper@agency.example.gov',
      dutyLocationId: denver,
    });
    await w.person({
      organizationId: bureau,
      name: 'Omar Farouk',
      title: 'Special Agent',
      address: 'omar.farouk@agency.example.gov',
      dutyLocationId: atlanta,
    });

    const rows = await w.queries.queryExportableRows(AT, PURPOSE);
    expect(rows.map((row) => row.dutyLocationStateCode).sort()).toEqual(['CO', 'GA']);
    // One employer, two states, and no state anywhere in the hierarchy.
    expect(new Set(rows.map((row) => row.organizationId)).size).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* 6 to 9: the relationships the old model could not express                    */
/* -------------------------------------------------------------------------- */

describe('the neutral model represents public-sector employment as it really is', () => {
  it('6: one person with several simultaneous assignments', async () => {
    const w = await world();
    const county = await w.org({
      name: 'Sample County',
      typeCode: 'county_government',
      levelCode: 'county',
    });
    const district = await w.org({
      name: 'Sample Water District',
      typeCode: 'special_district',
      levelCode: 'special_district',
    });

    const parsed = parsePersonName('Alex Rivera');
    const identityKey = personIdentityKey({ organizationId: county, parsed });
    const shared = {
      fullNamePublished: 'Alex Rivera',
      nameParts: parsed,
      identityKey,
      organizationalUnitId: null,
      dutyLocationId: null,
      roleCategoryCode: 'analyst',
      jobFamilyCode: 'research_policy',
      seniorityCode: 'staff',
      specialty: null,
      normalizationMethod: 'rule_table' as const,
      normalizationRuleSource: 'base',
      taxonomyVersion: 'test',
      normalizationConfidence: 0.9,
      departmentPublished: null,
      emails: [],
      sourceDocumentId: w.documentId,
      crawlRunId: null,
      extractionMethod: 'html_table' as const,
      confidence: 0.9,
      observedAt: AT,
    };

    await w.ingestion.ingestPerson({
      ...shared,
      recordKey: 'r1',
      organizationId: county,
      titlePublished: 'Budget Analyst',
      titleNormalized: 'Budget Analyst',
    });
    await w.ingestion.ingestPerson({
      ...shared,
      recordKey: 'r2',
      organizationId: district,
      titlePublished: 'Board Member',
      titleNormalized: 'Board Member',
    });

    // One person, two organizations, two concurrent titles.
    expect(await w.database.count('people')).toBe(1);
    expect(await w.database.count('employment_assignments')).toBe(2);
    const titles = await w.database.query<{ title_published: string }>(
      'select title_published from employment_assignments order by title_published',
    );
    expect(titles.rows.map((row) => row.title_published)).toEqual([
      'Board Member',
      'Budget Analyst',
    ]);
  });

  it('7: an organization whose hierarchy changes over time', async () => {
    const w = await world();
    const oldParent = await w.org({
      name: 'Former Department',
      typeCode: 'state_agency',
      levelCode: 'state',
    });
    const newParent = await w.org({
      name: 'Successor Department',
      typeCode: 'state_agency',
      levelCode: 'state',
    });
    const office = await w.org({
      name: 'Regional Office',
      typeCode: 'state_regional_office',
      levelCode: 'state',
    });

    await w.partOf(oldParent, office, '2015-01-01', '2023-12-31');
    await w.partOf(newParent, office, '2024-01-01', null);

    expect(await w.organizations.ancestorsOf(office, '2019-06-01')).toEqual([oldParent]);
    expect(await w.organizations.ancestorsOf(office, '2026-06-01')).toEqual([newParent]);
    // Neither edge is destroyed, so the reorganization stays readable.
    expect(await w.database.count('organization_relationships')).toBe(2);
  });

  it('8: organization-subtree suppression, in SQL and in memory', async () => {
    const w = await world();
    const department = await w.org({
      name: 'Department',
      typeCode: 'federal_department',
      levelCode: 'federal',
    });
    const bureau = await w.org({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    const office = await w.org({
      name: 'Field Office',
      typeCode: 'federal_field_office',
      levelCode: 'federal',
    });
    const county = await w.org({
      name: 'Unrelated County',
      typeCode: 'county_government',
      levelCode: 'county',
    });
    await w.partOf(department, bureau);
    await w.partOf(bureau, office);

    await w.person({
      organizationId: bureau,
      name: 'Jane Smith',
      title: 'Program Analyst',
      address: 'jane.smith@agency.example.gov',
    });
    await w.person({
      organizationId: office,
      name: 'Omar Farouk',
      title: 'Special Agent',
      address: 'omar.farouk@agency.example.gov',
    });
    await w.person({
      organizationId: county,
      name: 'Rosa Delgado',
      title: 'Clerk',
      address: 'rosa.delgado@county.example.org',
    });

    expect(await w.queries.queryExportableRows(AT, PURPOSE)).toHaveLength(3);

    await w.compliance.addSuppression({
      scope: 'organization_subtree',
      value: department,
      organizationId: department,
      reason: 'the department asked not to be contacted',
      source: 'opt_out_request',
      createdBy: 'ops',
      effectiveAt: EFFECTIVE_FROM,
    });

    // Enforced in SQL.
    const rows = await w.queries.queryExportableRows(AT, PURPOSE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationName).toBe('Unrelated County');

    // And independently in memory, on the same entries.
    const index = SuppressionIndex.fromEntries(await w.compliance.loadActiveSuppressions());
    const hierarchy = new OrganizationHierarchy([
      { parentOrganizationId: department, childOrganizationId: bureau },
      { parentOrganizationId: bureau, childOrganizationId: office },
    ]);
    for (const organizationId of [department, bureau, office]) {
      expect(
        index.isSuppressed(
          { organizationId, organizationAncestorIds: hierarchy.ancestorsOf(organizationId) },
          AT,
        ),
      ).toBe(true);
    }
    expect(index.isSuppressed({ organizationId: county, organizationAncestorIds: [] }, AT)).toBe(
      false,
    );
  });

  it('9: a federal worker with a duty location and no state organizational parent', async () => {
    const w = await world();
    const federal = await w.jurisdiction('us-federal', 'United States', 'federal');
    const bureau = await w.org({
      name: 'Sample Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
      jurisdictionId: federal,
    });
    const colorado = await w.area('state', 'Colorado', 'CO');
    const denver = await w.location(bureau, 'Denver', 'CO', colorado);
    await w.person({
      organizationId: bureau,
      name: 'Grace Hopper',
      title: 'Program Analyst',
      address: 'grace.hopper@agency.example.gov',
      dutyLocationId: denver,
    });

    // No organization above the bureau at all.
    expect(await w.organizations.ancestorsOf(bureau)).toEqual([]);

    const row = (await w.queries.queryExportableRows(AT, PURPOSE))[0];
    expect(row?.parentOrganizationId).toBeNull();
    expect(row?.governmentLevelCode).toBe('federal');
    expect(row?.jurisdictionName).toBe('United States');
    // The duty location is geographic and implies no organizational parent.
    expect(row?.dutyLocationStateCode).toBe('CO');
    expect(row?.dutyLocationCity).toBe('Denver');
  });
});

/* -------------------------------------------------------------------------- */
/* 10: a non-HTML official source                                              */
/* -------------------------------------------------------------------------- */

describe('a non-HTML official data source', () => {
  const CSV = [
    'AGENCY_NAME,AGENCY_CODE,PARENT_AGENCY,COUNTY,WEBSITE',
    'Bureau of Sample Affairs,123,Department of Samples,Harris,https://bsa.example.gov',
    '"Office of Records, Western",124,Bureau of Sample Affairs,Travis,https://records.example.gov',
    'Sample Field Station,125,Bureau of Sample Affairs,,',
  ].join('\n');

  const config: JurisdictionConfig = {
    key: 'us-federal-sample',
    name: 'United States, sample agency',
    governmentLevelCode: 'federal',
    sectorCodes: ['general_government'],
    jurisdiction: {
      code: 'us-federal',
      name: 'United States',
      stateCode: null,
      areaFipsCode: null,
    },
    officialSources: [
      {
        key: 'agency-list',
        name: 'Sample agency list',
        url: 'https://example.gov/agencies.csv',
        sourceTypeCode: 'csv',
        format: 'csv',
        provides: 'A list of agencies and their parents.',
        verified: false,
        verificationNote: 'placeholder for the extensibility test',
      },
    ],
    columnMappings: {
      agencyList: {
        organizationName: 'AGENCY_NAME',
        organizationId: 'AGENCY_CODE',
        parentOrganizationName: 'PARENT_AGENCY',
        countyName: 'COUNTY',
        websiteUrl: 'WEBSITE',
      },
    },
    identifierMappings: [
      {
        identifierSystemCode: 'cgac_agency_code',
        officialName: 'CGAC agency code',
        pattern: '^\\d{3}$',
        description: 'placeholder',
      },
    ],
    areaAliases: {},
    expectedAreaCount: null,
    seedOrganizations: [],
    crawlPolicy: {},
    domainDenyList: [],
    extraUrlExclusions: [],
    notes: [],
  };

  it('imports organizations from a CSV with no adapter and no crawl', () => {
    const importer = new DelimitedOrganizationImporter('csv');
    const result = importer.import(
      CSV,
      config.officialSources[0]!,
      config.columnMappings['agencyList']!,
      config,
      {
        // The shipped configuration is deliberately unverified.
        allowUnverified: true,
      },
    );

    expect(result.organizations).toHaveLength(3);
    expect(result.rejected).toEqual([]);
    // Quoted fields containing a comma survive intact.
    expect(result.organizations[1]?.name).toBe('Office of Records, Western');
    expect(result.organizations[0]).toMatchObject({
      officialId: '123',
      parentName: 'Department of Samples',
      countyName: 'Harris',
      websiteUrl: 'https://bsa.example.gov',
    });
    // A federal row needs no state, and none is invented for it.
    expect(result.organizations[2]?.countyName).toBeNull();
  });

  it('refuses an unverified source before it parses a byte', () => {
    // The gate used to be a function anyone could call and nobody did. It is
    // now the first statement of the only path into the parser, so an unread
    // government file cannot be imported by forgetting a line.
    const importer = new DelimitedOrganizationImporter('csv');
    const source = config.officialSources[0]!;
    expect(source.verified).toBe(false);

    expect(() =>
      importer.import(CSV, source, config.columnMappings['agencyList']!, config),
    ).toThrow(/is not marked verified/);
  });

  it('imports once a person has confirmed the source', () => {
    const importer = new DelimitedOrganizationImporter('csv');
    const verified = { ...config.officialSources[0]!, verified: true };
    const result = importer.import(CSV, verified, config.columnMappings['agencyList']!, config);
    expect(result.organizations).toHaveLength(3);
  });

  it('rejects an unmappable row with a reason rather than dropping it', () => {
    const importer = new DelimitedOrganizationImporter('csv');
    const result = importer.import(
      `${CSV}\n,126,Bureau of Sample Affairs,,`,
      config.officialSources[0]!,
      config.columnMappings['agencyList']!,
      config,
      { allowUnverified: true },
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain('no organization name');
  });

  it('validates as a jurisdiction with no state above it', () => {
    expect(
      validateJurisdictionConfig(config, TAXONOMY).filter((issue) => issue.severity === 'error'),
    ).toEqual([]);
  });

  it('registers alongside the shipped jurisdiction', () => {
    const registry = buildJurisdictionRegistry().register(config);
    expect(registry.keys()).toEqual(['texas-education', 'us-federal-sample']);
    expect(registry.atLevel('federal')).toHaveLength(1);
  });

  it('refuses two configurations for the same jurisdiction key', () => {
    expect(() => new JurisdictionRegistry().register(config).register(config)).toThrow(
      /already registered/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* A new adapter, invented here, through unmodified core                       */
/* -------------------------------------------------------------------------- */

/** A directory platform that exists only in this test file. */
class PipeDelimitedAdapter implements DirectoryAdapter {
  readonly key = 'test-pipe-delimited';
  readonly version = '1.0.0';
  readonly displayName = 'Pipe delimited roster';
  readonly detectionThreshold = 0.5;
  readonly requiresBrowser = false;

  detect(context: DetectionContext): DetectionResult {
    const score = context.page?.body.startsWith('ROSTER|') === true ? 0.99 : 0;
    return {
      adapterKey: this.key,
      score,
      platformKey: 'pipe',
      reasons: ['leading ROSTER| marker'],
    };
  }

  discoverDirectories(): readonly DiscoveredDirectory[] {
    return [];
  }

  extractListing(page: FetchedPage, ctx: AdapterContext): ListingExtraction {
    const records: ExtractedPersonRecord[] = [];
    for (const [index, line] of page.body
      .split('\n')
      .slice(1)
      .filter((l) => l.trim().length > 0)
      .entries()) {
      const [name, title, organization, email] = line.split('|');
      const record = buildPersonRecord({
        adapterKey: this.key,
        sourceUrl: page.finalUrl,
        localKey: `${index}:${name ?? ''}`,
        fullNamePublished: name ?? '',
        titlePublished: title ?? null,
        organizationPublished: organization ?? null,
        emailSources: email === undefined ? [] : [email],
        vocabulary: ctx.vocabulary,
        extractionMethod: 'html_list',
        confidence: 0.85,
      });
      if (record !== null) records.push(record);
    }
    return {
      records,
      pagination: { kind: null, requests: [], exhausted: true, note: null },
      context: {},
      empty: records.length === 0,
      warnings: [],
    };
  }

  extractProfile(): ExtractedPersonRecord | null {
    return null;
  }

  discoverPagination(): PaginationPlan {
    return { kind: null, requests: [], exhausted: true, note: null };
  }
}

const ROSTER = [
  'ROSTER|v1',
  'Ada Lovelace|Program Analyst|Bureau of Sample Affairs|ada.lovelace@agency.example.gov',
  'Grace Hopper|Chief Information Officer|Bureau of Sample Affairs|grace.hopper@agency.example.gov',
  'Katherine Johnson|Research Analyst|Bureau of Sample Affairs|katherine.johnson@agency.example.gov',
].join('\n');

describe('a new directory adapter needs no change to the crawler core', () => {
  const adapter = new PipeDelimitedAdapter();
  const fixture = {
    name: 'pipe delimited roster',
    url: 'https://agency.example.gov/roster.txt',
    html: ROSTER,
    kind: 'listing' as const,
    context: { vocabulary: VOCABULARY },
    expected: { recordCount: 3, empty: false, paginationKind: null },
  };

  it('passes the shared contract checks', () => {
    expect(checkAdapterContract(adapter, fixture).filter((check) => !check.passed)).toEqual([]);
  });

  it('is selected by the registry over the shipped generic adapters', () => {
    const registry = buildAdapterRegistry().register(adapter);
    const page = fixturePage(fixture);
    const selection = registry.select({ url: page.url, page, hints: {}, vocabulary: VOCABULARY });
    expect(selection.adapter.key).toBe(adapter.key);
  });

  it('runs through the unmodified crawl engine', async () => {
    const engine = new CrawlEngine({
      fetcher: MapFetcher.from({ 'https://agency.example.gov/roster.txt': ROSTER }),
      robots: new PermissiveRobotsProvider(),
      logger: createSilentLogger(),
      sleep: () => Promise.resolve(),
    });
    const result = await engine.run({
      crawlRunId: 'run-ext',
      crawlTargetId: null,
      seedUrl: 'https://agency.example.gov/roster.txt',
      adapter,
      vocabulary: VOCABULARY,
      collectionMode: 'fixture',
      policy: withPolicyDefaults({ requestDelayMs: 0, respectRobots: false }),
    });
    expect(result.records.map((r) => r.record.fullNamePublished)).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
      'Katherine Johnson',
    ]);
    expect(result.records[0]?.record.organizationPublished).toBe('Bureau of Sample Affairs');
  });

  it('reports an unclaimed page instead of guessing', () => {
    const registry = new AdapterRegistry().register(adapter);
    const page = fixturePage({
      name: 'other',
      url: 'https://x.example.gov/',
      html: '<html><body>hello</body></html>',
      kind: 'listing',
    });
    expect(
      registry.trySelect({ url: page.url, page, hints: {}, vocabulary: VOCABULARY }),
    ).toBeNull();
  });
});
