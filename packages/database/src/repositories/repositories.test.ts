import { afterEach, describe, expect, it } from 'vitest';
import {
  canReplaceClassification,
  parsePersonName,
  personIdentityKey,
} from '@public-workforce/core';
import type { Uuid } from '@public-workforce/shared-types';
import { educationSectorPack } from '@public-workforce/sector-education';
import { federalGovernmentSectorPack } from '@public-workforce/sector-federal';
import { stateLocalGovernmentSectorPack } from '@public-workforce/sector-state-local';
import { TestDatabase } from '../testing.js';
import { IngestionRepository, type IngestPersonInput } from './ingestion.js';
import { OrganizationRepository } from './organizations.js';
import { ComplianceRepository } from './compliance.js';
import { QueryRepository } from './queries.js';
import { ExportRepository } from './exports.js';

const AT = '2026-06-01T00:00:00.000Z';
/** Before AT, so a suppression added in a test is in force when queried at AT. */
const EFFECTIVE_FROM = '2026-01-01T00:00:00.000Z';
const PURPOSE = 'internal-review';

const SECTORS = [educationSectorPack, stateLocalGovernmentSectorPack, federalGovernmentSectorPack];

interface Harness {
  database: TestDatabase;
  ingestion: IngestionRepository;
  organizations: OrganizationRepository;
  compliance: ComplianceRepository;
  queries: QueryRepository;
  documentId: Uuid;
  documentVersionId: Uuid;
  jurisdictionId: Uuid;
  makeOrganization: (input: {
    name: string;
    typeCode: string;
    levelCode: string;
    sectorCode?: string;
  }) => Promise<Uuid>;
  relate: (parentId: Uuid, childId: Uuid) => Promise<void>;
  addPerson: (organizationId: Uuid, name: string, title: string, address: string) => Promise<Uuid>;
}

let open: TestDatabase | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

async function harness(): Promise<Harness> {
  const database = await TestDatabase.create({ sectors: SECTORS });
  open = database;
  const ingestion = new IngestionRepository(database);
  const organizations = new OrganizationRepository(database);

  const document = await ingestion.recordSourceDocument({
    url: 'https://agency.example.gov/directory',
    urlCanonical: 'https://agency.example.gov/directory',
    urlHash: 'hash-directory',
    domain: 'agency.example.gov',
    sourceTypeCode: 'html_directory',
    httpStatus: 200,
    contentHash: 'content-1',
    contentType: 'text/html',
    storageKey: null,
    robotsAllowed: true,
    robotsPolicyNote: null,
    crawlRunId: null,
    retrievedAt: AT,
  });
  const documentId = document.documentId;
  const documentVersionId = document.versionId;

  const jurisdictionId = await organizations.upsertJurisdiction({
    code: 'us-federal',
    name: 'United States',
    governmentLevelCode: 'federal',
  });

  let counter = 0;
  const makeOrganization: Harness['makeOrganization'] = async (input) => {
    counter += 1;
    const created = await organizations.upsertOrganization({
      organizationTypeCode: input.typeCode,
      governmentLevelCode: input.levelCode,
      sectorCode: input.sectorCode ?? 'general_government',
      jurisdictionId,
      name: input.name,
      nameNormalized: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${counter}`,
      primaryDomain: 'agency.example.gov',
      sourceDocumentId: documentId,
      extractionMethod: 'manual',
      confidence: 1,
      observedAt: AT,
    });
    return created.id;
  };

  const relate: Harness['relate'] = async (parentId, childId) => {
    await organizations.upsertRelationship({
      parentOrganizationId: parentId,
      childOrganizationId: childId,
      relationshipTypeCode: 'part_of',
      effectiveFrom: '2020-01-01',
      sourceDocumentId: documentId,
      extractionMethod: 'manual',
      confidence: 1,
      observedAt: AT,
    });
  };

  const addPerson: Harness['addPerson'] = async (organizationId, name, title, address) => {
    const result = await ingestion.ingestPerson(
      personInput(organizationId, documentId, name, title, address),
    );
    return result.personId;
  };

  return {
    database,
    ingestion,
    organizations,
    compliance: new ComplianceRepository(database),
    queries: new QueryRepository(database),
    documentId,
    documentVersionId,
    jurisdictionId,
    makeOrganization,
    relate,
    addPerson,
  };
}

function personInput(
  organizationId: Uuid,
  documentId: Uuid,
  name: string,
  title: string,
  address: string,
): IngestPersonInput {
  const parsed = parsePersonName(name);
  return {
    recordKey: `record:${organizationId}:${name}`,
    organizationId,
    organizationalUnitId: null,
    dutyLocationId: null,
    fullNamePublished: name,
    nameParts: parsed,
    identityKey: personIdentityKey({ organizationId, parsed }),
    titlePublished: title,
    titleNormalized: title,
    roleCategoryCode: 'analyst',
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
        address,
        addressNormalized: address.toLowerCase(),
        domain: address.split('@')[1] as string,
        localPart: address.split('@')[0] as string,
        classification: 'published',
        obfuscation: 'none',
        sourceValue: address,
      },
    ],
    sourceDocumentId: documentId,
    crawlRunId: null,
    extractionMethod: 'html_table',
    confidence: 0.9,
    observedAt: AT,
  };
}

describe('OrganizationRepository', () => {
  it('creates organizations at any level without requiring a state', async () => {
    const h = await harness();
    const bureau = await h.makeOrganization({
      name: 'Sample Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    const county = await h.makeOrganization({
      name: 'Sample County',
      typeCode: 'county_government',
      levelCode: 'county',
    });
    const school = await h.makeOrganization({
      name: 'Sample High',
      typeCode: 'school',
      // An independent district's school. Education-sector work at the
      // special-district level; `education` is not a level.
      levelCode: 'special_district',
      sectorCode: 'education',
    });

    expect(await h.database.count('organizations')).toBe(3);
    const row = await h.database.query<{ jurisdiction_id: Uuid | null }>(
      'select jurisdiction_id from organizations where id = $1',
      [bureau],
    );
    expect(row.rows[0]?.jurisdiction_id).toBe(h.jurisdictionId);
    expect(county).not.toBe(school);
  });

  it('records one organization type at several government levels', async () => {
    // C9: level and sector are orthogonal, source-supported facts. A district
    // is an independent special district in most states and a department of a
    // city or a county in others, and all three are `school_district`. Nothing
    // pairs a type with a level, so all three can be stored.
    const h = await harness();
    const independent = await h.makeOrganization({
      name: 'Independent District',
      typeCode: 'school_district',
      levelCode: 'special_district',
      sectorCode: 'education',
    });
    const cityRun = await h.makeOrganization({
      name: 'City Schools',
      typeCode: 'school_district',
      levelCode: 'municipal',
      sectorCode: 'education',
    });
    const countyRun = await h.makeOrganization({
      name: 'County Schools',
      typeCode: 'school_district',
      levelCode: 'county',
      sectorCode: 'education',
    });

    expect(new Set([independent, cityRun, countyRun]).size).toBe(3);
    const levels = await h.database.query<{ government_level_code: string }>(
      `select government_level_code from organizations
       where organization_type_code = 'school_district' order by government_level_code`,
    );
    expect(levels.rows.map((row) => row.government_level_code)).toEqual([
      'county',
      'municipal',
      'special_district',
    ]);

    // The type's own default is null, precisely because it varies.
    const type = await h.database.query<{ default_government_level_code: string | null }>(
      `select default_government_level_code from organization_types
       where code = 'school_district'`,
    );
    expect(type.rows[0]?.default_government_level_code).toBeNull();
  });

  it('resolves an identifier-less recrawl to the same organization', async () => {
    // The old fallback inserted unconditionally without an identifier, so every
    // recrawl of a directory duplicated every organization on it.
    const h = await harness();
    const input = {
      organizationTypeCode: 'county_government',
      governmentLevelCode: 'county',
      sectorCode: 'general_government',
      jurisdictionId: h.jurisdictionId,
      name: 'Sample County',
      nameNormalized: 'sample-county',
      primaryDomain: 'co.sample.example.gov',
      sourceDocumentId: h.documentId,
      extractionMethod: 'html_table',
      confidence: 0.9,
      observedAt: AT,
    } as const;

    const first = await h.organizations.upsertOrganization(input);
    const second = await h.organizations.upsertOrganization(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.identity.tier).toBe('domain_scoped_name');
    expect(await h.database.count('organizations')).toBe(1);
  });

  it('keeps same-named schools in different districts apart', async () => {
    const h = await harness();
    const northDistrict = await h.makeOrganization({
      name: 'North District',
      typeCode: 'school_district',
      levelCode: 'special_district',
      sectorCode: 'education',
    });
    const southDistrict = await h.makeOrganization({
      name: 'South District',
      typeCode: 'school_district',
      levelCode: 'special_district',
      sectorCode: 'education',
    });

    const school = (parentOrganizationId: Uuid) =>
      h.organizations.upsertOrganization({
        organizationTypeCode: 'school',
        governmentLevelCode: 'special_district',
        sectorCode: 'education',
        jurisdictionId: h.jurisdictionId,
        parentOrganizationId,
        name: 'Lincoln Elementary',
        nameNormalized: 'lincoln-elementary',
        sourceDocumentId: h.documentId,
        extractionMethod: 'html_table',
        confidence: 0.9,
        observedAt: AT,
      });

    const north = await school(northDistrict);
    const south = await school(southDistrict);

    expect(north.id).not.toBe(south.id);
    expect(north.identity.tier).toBe('parent_scoped_name');
    // And re-observing either one is still idempotent.
    expect((await school(northDistrict)).id).toBe(north.id);
    expect(await h.database.count('organizations')).toBe(4);
  });

  it('keeps same-named departments in different municipalities apart', async () => {
    const h = await harness();
    const springfield = await h.makeOrganization({
      name: 'Springfield',
      typeCode: 'municipality',
      levelCode: 'municipal',
    });
    const shelbyville = await h.makeOrganization({
      name: 'Shelbyville',
      typeCode: 'municipality',
      levelCode: 'municipal',
    });

    const department = (parentOrganizationId: Uuid) =>
      h.organizations.upsertOrganization({
        organizationTypeCode: 'municipal_department',
        governmentLevelCode: 'municipal',
        sectorCode: 'parks_recreation',
        jurisdictionId: h.jurisdictionId,
        parentOrganizationId,
        name: 'Parks and Recreation',
        nameNormalized: 'parks-and-recreation',
        sourceDocumentId: h.documentId,
        extractionMethod: 'html_table',
        confidence: 0.9,
        observedAt: AT,
      });

    const first = await department(springfield);
    const second = await department(shelbyville);
    expect(first.id).not.toBe(second.id);
  });

  it('sends an ambiguous organization to review instead of merging it', async () => {
    const h = await harness();
    const ambiguous = {
      organizationTypeCode: 'other_public_body',
      governmentLevelCode: 'other_public_authority',
      sectorCode: 'other',
      jurisdictionId: null,
      name: 'Regional Board',
      nameNormalized: 'regional-board',
      sourceDocumentId: h.documentId,
      extractionMethod: 'mailto_harvest',
      confidence: 0.4,
      observedAt: AT,
    } as const;

    const created = await h.organizations.upsertOrganization(ambiguous);
    expect(created.identity.tier).toBe('ambiguous');
    expect(created.identity.needsReview).toBe(true);
    expect(created.identity.reviewReason).toContain('no official identifier');

    // Still idempotent: the same source record finds the same row.
    const again = await h.organizations.upsertOrganization(ambiguous);
    expect(again.id).toBe(created.id);
    expect(await h.database.count('organizations')).toBe(1);

    const queue = await h.organizations.identityReviewQueue();
    expect(queue.map((row) => row.name)).toEqual(['Regional Board']);
  });

  it('prefers the strongest evidence available, in order', async () => {
    const h = await harness();
    const base = {
      organizationTypeCode: 'state_agency',
      governmentLevelCode: 'state',
      sectorCode: 'general_government',
      jurisdictionId: h.jurisdictionId,
      name: 'Department of Samples',
      nameNormalized: 'department-of-samples',
      primaryDomain: 'samples.example.gov',
      sourceDocumentId: h.documentId,
      extractionMethod: 'html_table',
      confidence: 0.9,
      observedAt: AT,
    } as const;

    expect(
      h.organizations.resolveIdentity({
        ...base,
        identifier: { systemCode: 'fips_state', value: '48' },
        sourceIdentifier: { system: 'portal', value: 'A1' },
        parentOrganizationId: h.jurisdictionId,
      }).tier,
    ).toBe('official_identifier');
    expect(
      h.organizations.resolveIdentity({
        ...base,
        sourceIdentifier: { system: 'portal', value: 'A1' },
        parentOrganizationId: h.jurisdictionId,
      }).tier,
    ).toBe('source_identifier');
    expect(
      h.organizations.resolveIdentity({ ...base, parentOrganizationId: h.jurisdictionId }).tier,
    ).toBe('parent_scoped_name');
    expect(h.organizations.resolveIdentity(base).tier).toBe('domain_scoped_name');
    expect(
      h.organizations.resolveIdentity({ ...base, primaryDomain: null, jurisdictionId: null }).tier,
    ).toBe('ambiguous');
  });

  it('keys on an official identifier when one is supplied', async () => {
    const h = await harness();
    const first = await h.organizations.upsertOrganization({
      organizationTypeCode: 'federal_bureau',
      governmentLevelCode: 'federal',
      sectorCode: 'general_government',
      name: 'Sample Bureau',
      nameNormalized: 'sample-bureau',
      sourceDocumentId: h.documentId,
      extractionMethod: 'file_import',
      confidence: 1,
      observedAt: AT,
      identifier: { systemCode: 'cgac_agency_code', value: '123' },
    });
    const second = await h.organizations.upsertOrganization({
      organizationTypeCode: 'federal_bureau',
      governmentLevelCode: 'federal',
      sectorCode: 'general_government',
      name: 'Sample Bureau (renamed)',
      nameNormalized: 'sample-bureau-renamed',
      sourceDocumentId: h.documentId,
      extractionMethod: 'file_import',
      confidence: 1,
      observedAt: AT,
      identifier: { systemCode: 'cgac_agency_code', value: '123' },
    });

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(await h.database.count('organizations')).toBe(1);
  });

  it('refuses two organizations claiming the same official identifier', async () => {
    const h = await harness();
    const org = await h.makeOrganization({
      name: 'A',
      typeCode: 'state_agency',
      levelCode: 'state',
    });
    const other = await h.makeOrganization({
      name: 'B',
      typeCode: 'state_agency',
      levelCode: 'state',
    });
    const identifier = {
      identifierSystemCode: 'cgac_agency_code',
      identifierValue: '999',
      sourceDocumentId: h.documentId,
      extractionMethod: 'manual' as const,
      confidence: 1,
      observedAt: AT,
    };
    await h.organizations.upsertExternalIdentifier({
      entityType: 'organization',
      entityId: org,
      ...identifier,
    });
    await expect(
      h.organizations.upsertExternalIdentifier({
        entityType: 'organization',
        entityId: other,
        ...identifier,
      }),
    ).resolves.toBeDefined();
    const rows = await h.database.query<{ entity_id: Uuid }>(
      `select entity_id from external_identifiers where identifier_value = '999'`,
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('resolves ancestry through several levels', async () => {
    const h = await harness();
    const dept = await h.makeOrganization({
      name: 'Department',
      typeCode: 'federal_department',
      levelCode: 'federal',
    });
    const bureau = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    const office = await h.makeOrganization({
      name: 'Field Office',
      typeCode: 'federal_field_office',
      levelCode: 'federal',
    });
    await h.relate(dept, bureau);
    await h.relate(bureau, office);

    expect(await h.organizations.ancestorsOf(office)).toEqual([bureau, dept]);
    expect(await h.organizations.ancestorsOf(dept)).toEqual([]);
    expect((await h.organizations.descendantsOf(dept)).sort()).toEqual([bureau, office].sort());
  });

  it('does not roll up through a relationship that is not containment', async () => {
    const h = await harness();
    const oversight = await h.makeOrganization({
      name: 'Oversight Board',
      typeCode: 'public_authority',
      levelCode: 'other_public_authority',
    });
    const agency = await h.makeOrganization({
      name: 'Agency',
      typeCode: 'state_agency',
      levelCode: 'state',
    });
    await h.organizations.upsertRelationship({
      parentOrganizationId: oversight,
      childOrganizationId: agency,
      relationshipTypeCode: 'oversees',
      effectiveFrom: '2020-01-01',
      sourceDocumentId: h.documentId,
      extractionMethod: 'manual',
      confidence: 1,
      observedAt: AT,
    });
    expect(await h.organizations.ancestorsOf(agency)).toEqual([]);
  });

  it('reflects a hierarchy that changes over time', async () => {
    const h = await harness();
    const oldParent = await h.makeOrganization({
      name: 'Old Parent',
      typeCode: 'state_agency',
      levelCode: 'state',
    });
    const newParent = await h.makeOrganization({
      name: 'New Parent',
      typeCode: 'state_agency',
      levelCode: 'state',
    });
    const child = await h.makeOrganization({
      name: 'Child',
      typeCode: 'state_regional_office',
      levelCode: 'state',
    });

    await h.organizations.upsertRelationship({
      parentOrganizationId: oldParent,
      childOrganizationId: child,
      relationshipTypeCode: 'part_of',
      effectiveFrom: '2018-01-01',
      effectiveTo: '2023-12-31',
      sourceDocumentId: h.documentId,
      extractionMethod: 'manual',
      confidence: 1,
      observedAt: AT,
    });
    await h.organizations.upsertRelationship({
      parentOrganizationId: newParent,
      childOrganizationId: child,
      relationshipTypeCode: 'part_of',
      effectiveFrom: '2024-01-01',
      sourceDocumentId: h.documentId,
      extractionMethod: 'manual',
      confidence: 1,
      observedAt: AT,
    });

    expect(await h.organizations.ancestorsOf(child, '2020-06-01')).toEqual([oldParent]);
    expect(await h.organizations.ancestorsOf(child, '2025-06-01')).toEqual([newParent]);
    // Both edges are retained, so the history is readable.
    expect(await h.database.count('organization_relationships')).toBe(2);
  });

  it('refuses an organization related to itself', async () => {
    const h = await harness();
    const org = await h.makeOrganization({
      name: 'Self',
      typeCode: 'state_agency',
      levelCode: 'state',
    });
    await expect(h.relate(org, org)).rejects.toThrow();
  });
});

describe('IngestionRepository', () => {
  it('creates a person, an assignment and an address', async () => {
    const h = await harness();
    const org = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    const result = await h.ingestion.ingestPerson(
      personInput(
        org,
        h.documentId,
        'Jane Smith',
        'Program Analyst',
        'jane.smith@agency.example.gov',
      ),
    );
    expect(result.personCreated).toBe(true);
    expect(await h.database.count('people')).toBe(1);
    expect(await h.database.count('employment_assignments')).toBe(1);
    expect(await h.database.count('email_addresses')).toBe(1);
  });

  it('ingesting the same record twice does not duplicate anything', async () => {
    const h = await harness();
    const org = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    const input = personInput(
      org,
      h.documentId,
      'Jane Smith',
      'Program Analyst',
      'jane.smith@agency.example.gov',
    );
    const first = await h.ingestion.ingestPerson(input);
    const second = await h.ingestion.ingestPerson({
      ...input,
      observedAt: '2026-07-01T00:00:00.000Z',
    });

    expect(second.personId).toBe(first.personId);
    expect(second.personCreated).toBe(false);
    expect(await h.database.count('people')).toBe(1);
    expect(await h.database.count('employment_assignments')).toBe(1);
    expect(await h.database.count('email_addresses')).toBe(1);
  });

  it('gives one person several simultaneous assignments at different organizations', async () => {
    const h = await harness();
    const county = await h.makeOrganization({
      name: 'County',
      typeCode: 'county_government',
      levelCode: 'county',
    });
    const board = await h.makeOrganization({
      name: 'Water District',
      typeCode: 'special_district',
      levelCode: 'special_district',
    });

    await h.ingestion.ingestPerson(
      personInput(
        county,
        h.documentId,
        'Alex Rivera',
        'Budget Analyst',
        'alex.rivera@county.example.org',
      ),
    );
    await h.ingestion.ingestPerson(
      personInput(
        board,
        h.documentId,
        'Alex Rivera',
        'Board Member',
        'alex.rivera@water.example.org',
      ),
    );

    // Identity is organization-scoped, so these are two people until a shared
    // published address links them. Both assignments are retained either way.
    expect(await h.database.count('employment_assignments')).toBe(2);
  });

  it('widens the seen window on a repeat collection instead of overwriting it', async () => {
    const h = await harness();
    const org = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    const input = personInput(
      org,
      h.documentId,
      'Jane Smith',
      'Program Analyst',
      'jane.smith@agency.example.gov',
    );
    await h.ingestion.ingestPerson(input);
    await h.ingestion.ingestPerson({ ...input, observedAt: '2026-09-01T00:00:00.000Z' });

    const row = await h.database.query<{ first_seen_at: Date; last_seen_at: Date }>(
      'select first_seen_at, last_seen_at from people',
    );
    expect(new Date(row.rows[0]!.first_seen_at).toISOString()).toBe(AT);
    expect(new Date(row.rows[0]!.last_seen_at).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('upgrades a decoded address to published but never the reverse', async () => {
    const h = await harness();
    const org = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    const base = personInput(
      org,
      h.documentId,
      'Jane Smith',
      'Program Analyst',
      'jane.smith@agency.example.gov',
    );
    const decoded = {
      ...base,
      emails: [
        {
          ...base.emails[0]!,
          classification: 'decoded_published' as const,
          obfuscation: 'cloudflare_cfemail' as const,
        },
      ],
    };
    const classification = async (): Promise<string | undefined> =>
      (
        await h.database.query<{ classification: string }>(
          'select classification from email_addresses',
        )
      ).rows[0]?.classification;

    await h.ingestion.ingestPerson(decoded);
    expect(await classification()).toBe('decoded_published');
    await h.ingestion.ingestPerson(base);
    expect(await classification()).toBe('published');
    await h.ingestion.ingestPerson(decoded);
    expect(await classification()).toBe('published');
  });

  it('rejects an inferred classification in email_addresses at the database level', async () => {
    const h = await harness();
    const org = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    const { personId } = await h.ingestion.ingestPerson(
      personInput(
        org,
        h.documentId,
        'Jane Smith',
        'Program Analyst',
        'jane.smith@agency.example.gov',
      ),
    );
    await expect(
      h.database.query(
        `insert into email_addresses (person_id, address, address_normalized, domain, local_part,
           classification, source_document_id, extraction_method)
         values ($1,'guess@x.example.gov','guess@x.example.gov','x.example.gov','guess','inferred_candidate',$2,'manual')`,
        [personId, h.documentId],
      ),
    ).rejects.toThrow();
  });

  it('refuses a record with no provenance', async () => {
    const h = await harness();
    await expect(
      h.database.query(
        `insert into people (full_name_published, identity_key, extraction_method)
         values ('Ghost Person','nowhere|ghost','manual')`,
      ),
    ).rejects.toThrow();
  });

  it('stores a professional contact point alongside the address', async () => {
    const h = await harness();
    const org = await h.makeOrganization({
      name: 'County',
      typeCode: 'county_government',
      levelCode: 'county',
    });
    const base = personInput(
      org,
      h.documentId,
      'Jane Smith',
      'Clerk',
      'jane.smith@county.example.org',
    );
    await h.ingestion.ingestPerson({
      ...base,
      contactPoints: [
        {
          contactPointTypeCode: 'work_phone',
          value: '555-010-1001',
          valueNormalized: '5550101001',
          sourceValue: '(555) 010-1001',
        },
      ],
    });
    expect(await h.database.count('contact_points')).toBe(1);
  });

  it('appends a version when the content changes, keeping the old one', async () => {
    // The old shape overwrote content_hash on every fetch, so the record of
    // what the page used to say was destroyed by the crawl that noticed it had
    // changed.
    const h = await harness();
    const recordFetch = (contentHash: string, retrievedAt: string) =>
      h.ingestion.recordSourceDocument({
        url: 'https://agency.example.gov/staff',
        urlCanonical: 'https://agency.example.gov/staff',
        urlHash: 'hash-staff',
        domain: 'agency.example.gov',
        sourceTypeCode: 'html_directory',
        httpStatus: 200,
        contentHash,
        contentType: 'text/html',
        storageKey: null,
        robotsAllowed: true,
        robotsPolicyNote: null,
        crawlRunId: null,
        retrievedAt,
      });

    const first = await recordFetch('content-a', AT);
    const changed = await recordFetch('content-b', '2026-07-01T00:00:00.000Z');

    expect(changed.documentId).toBe(first.documentId);
    expect(changed.versionId).not.toBe(first.versionId);
    expect(first.version).toBe(1);
    expect(changed.version).toBe(2);
    expect(changed.isNewVersion).toBe(true);

    const versions = await h.database.query<{ content_hash: string; version: number }>(
      `select content_hash, version from source_document_versions
       where source_document_id = $1 order by version`,
      [first.documentId],
    );
    expect(versions.rows.map((row) => row.content_hash)).toEqual(['content-a', 'content-b']);
  });

  it('re-fetching identical content adds no version', async () => {
    const h = await harness();
    const recordFetch = (retrievedAt: string) =>
      h.ingestion.recordSourceDocument({
        url: 'https://agency.example.gov/staff',
        urlCanonical: 'https://agency.example.gov/staff',
        urlHash: 'hash-staff',
        domain: 'agency.example.gov',
        sourceTypeCode: 'html_directory',
        httpStatus: 200,
        contentHash: 'unchanged',
        contentType: 'text/html',
        storageKey: null,
        robotsAllowed: true,
        robotsPolicyNote: null,
        crawlRunId: null,
        retrievedAt,
      });

    const first = await recordFetch(AT);
    const second = await recordFetch('2026-07-01T00:00:00.000Z');
    expect(second.versionId).toBe(first.versionId);
    expect(second.isNewVersion).toBe(false);
    expect(await h.database.count('source_document_versions')).toBe(2); // harness + this one

    // The last-seen window moved, which is the only thing a re-fetch changes.
    const row = await h.database.query<{ last_seen_at: string; retrieved_at: string }>(
      'select last_seen_at, retrieved_at from source_document_versions where id = $1',
      [first.versionId],
    );
    expect(new Date(row.rows[0]?.last_seen_at ?? 0).toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(new Date(row.rows[0]?.retrieved_at ?? 0).toISOString()).toBe(AT);
  });

  it('keeps a superseded observation readable after the page changes', async () => {
    const h = await harness();
    const record = (versionId: Uuid, value: string) =>
      h.ingestion.recordObservation({
        sourceDocumentVersionId: versionId,
        crawlRunId: null,
        evidenceClass: 'employment',
        entityType: 'person',
        entityId: null,
        recordKey: 'record:1',
        field: 'title_published',
        valueRaw: value,
        valueNormalized: value.toLowerCase(),
        extractionMethod: 'html_table',
        confidence: 0.9,
        selector: 'table > tr',
        observedAt: AT,
      });

    const recordFetch = (contentHash: string) =>
      h.ingestion.recordSourceDocument({
        url: 'https://agency.example.gov/staff',
        urlCanonical: 'https://agency.example.gov/staff',
        urlHash: 'hash-staff',
        domain: 'agency.example.gov',
        sourceTypeCode: 'html_directory',
        httpStatus: 200,
        contentHash,
        contentType: 'text/html',
        storageKey: null,
        robotsAllowed: true,
        robotsPolicyNote: null,
        crawlRunId: null,
        retrievedAt: AT,
      });

    const v1 = await recordFetch('content-a');
    await record(v1.versionId, 'Analyst');
    const v2 = await recordFetch('content-b');
    await record(v2.versionId, 'Senior Analyst');

    const observations = await h.database.query<{ value_raw: string }>(
      `select o.value_raw from source_observations o
       join source_document_versions v on v.id = o.source_document_version_id
       where o.record_key = 'record:1' order by v.version`,
    );
    expect(observations.rows.map((row) => row.value_raw)).toEqual(['Analyst', 'Senior Analyst']);
  });

  it('refuses to delete an observation or rewrite a version', async () => {
    const h = await harness();
    // Row-level triggers need a row to fire on, so record one first.
    await h.ingestion.recordObservation({
      sourceDocumentVersionId: h.documentVersionId,
      crawlRunId: null,
      evidenceClass: 'employment',
      entityType: 'person',
      entityId: null,
      recordKey: 'record:immutable',
      field: 'title_published',
      valueRaw: 'Analyst',
      valueNormalized: 'analyst',
      extractionMethod: 'html_table',
      confidence: 0.9,
      selector: null,
      observedAt: AT,
    });
    await expect(h.database.query('delete from source_observations where true')).rejects.toThrow(
      /append-only/,
    );
    await expect(
      h.database.query(`update source_document_versions set content_hash = 'tampered'`),
    ).rejects.toThrow(/immutable/);
  });

  it('replaces a stored classification exactly as canReplaceClassification says', async () => {
    // One policy, two places it has to hold. The function is the readable
    // statement; the `on conflict` clause is what actually runs. This asserts
    // they agree on every pair rather than trusting a comment that says so.
    const observed = ['published', 'decoded_published', 'general_inbox', 'invalid'] as const;
    for (const stored of observed) {
      for (const incoming of observed) {
        const h = await harness();
        const organizationId = await h.makeOrganization({
          name: 'Sample Agency',
          typeCode: 'federal_agency',
          levelCode: 'federal',
        });
        const address = 'pat.doe@agency.example.gov';
        const write = (classification: (typeof observed)[number]) =>
          h.ingestion.ingestPerson({
            ...personInput(organizationId, h.documentId, 'Pat Doe', 'Analyst', address),
            emails: [
              {
                address,
                addressNormalized: address,
                domain: 'agency.example.gov',
                localPart: 'pat.doe',
                classification,
                obfuscation: 'none',
                sourceValue: address,
              },
            ],
          });

        await write(stored);
        await write(incoming);

        const row = await h.database.query<{ classification: string }>(
          'select classification from email_addresses where address_normalized = $1',
          [address],
        );
        const expected = canReplaceClassification(stored, incoming) ? incoming : stored;
        expect(row.rows[0]?.classification, `${stored} then ${incoming}`).toBe(expected);
        await h.database.close();
        open = null;
      }
    }
  });

  it('keeps a rejected or suppressed candidate out of an export', async () => {
    const h = await harness();
    const organizationId = await h.makeOrganization({
      name: 'Sample Agency',
      typeCode: 'federal_agency',
      levelCode: 'federal',
    });
    const personId = await h.addPerson(
      organizationId,
      'Dana Lee',
      'Analyst',
      'dana.lee@agency.example.gov',
    );

    const addCandidate = async (address: string, state: string) => {
      await h.database.query(
        `insert into email_candidates (person_id, organization_id, domain, address, pattern, state)
         values ($1,$2,'agency.example.gov',$3,'first.last',$4)`,
        [personId, organizationId, address, state],
      );
    };

    await addCandidate('d.lee@agency.example.gov', 'suppressed');
    const rowsWithSuppressed = await h.queries.queryExportableRows(AT, 'internal-review');
    expect(rowsWithSuppressed[0]?.inferredEmailCandidate).toBeNull();

    await h.database.query(`delete from email_candidates`);
    await addCandidate('dana.l@agency.example.gov', 'rejected');
    const rowsWithRejected = await h.queries.queryExportableRows(AT, 'internal-review');
    expect(rowsWithRejected[0]?.inferredEmailCandidate).toBeNull();

    await h.database.query(`delete from email_candidates`);
    await addCandidate('dl@agency.example.gov', 'pending');
    const rowsWithPending = await h.queries.queryExportableRows(AT, 'internal-review');
    expect(rowsWithPending[0]?.inferredEmailCandidate).toBe('dl@agency.example.gov');
  });

  it('records observations idempotently, tagged with what they prove', async () => {
    const h = await harness();
    for (const evidenceClass of ['employment', 'employment']) {
      await h.ingestion.recordObservation({
        sourceDocumentVersionId: h.documentVersionId,
        crawlRunId: null,
        evidenceClass,
        entityType: 'person',
        entityId: null,
        recordKey: 'record:1',
        field: 'full_name_published',
        valueRaw: 'Jane Smith',
        valueNormalized: 'jane smith',
        extractionMethod: 'html_table',
        confidence: 0.9,
        selector: 'table > tr',
        observedAt: AT,
      });
    }
    expect(await h.database.count('source_observations')).toBe(1);
  });

  it('keeps employment evidence and contact evidence as separate rows', async () => {
    const h = await harness();
    for (const [evidenceClass, field] of [
      ['employment', 'title_published'],
      ['contact', 'email_published'],
    ]) {
      await h.ingestion.recordObservation({
        sourceDocumentVersionId: h.documentVersionId,
        crawlRunId: null,
        evidenceClass: evidenceClass as string,
        entityType: 'person',
        entityId: null,
        recordKey: 'record:1',
        field: field as string,
        valueRaw: 'x',
        valueNormalized: 'x',
        extractionMethod: 'html_table',
        confidence: 0.9,
        selector: null,
        observedAt: AT,
      });
    }
    expect(await h.database.count('source_observations')).toBe(2);
    expect(await h.database.count('source_observations', "evidence_class = 'contact'")).toBe(1);
  });
});

describe('ComplianceRepository', () => {
  it('records an email complaint and the suppression it creates', async () => {
    const h = await harness();
    const result = await h.compliance.recordComplaint({
      channel: 'email',
      contactType: 'email',
      contactValue: 'Jane.Smith@Agency.example.gov',
      reason: 'asked to be removed',
      createdBy: 'ops',
    });
    expect(result.suppressionEntryId).not.toBeNull();
    expect(result.resolution).toBe('suppressed');
    const entries = await h.compliance.loadActiveSuppressions();
    expect(entries.map((entry) => entry.value)).toContain('jane.smith@agency.example.gov');
  });

  it('resolves an email complaint to the person who holds the address', async () => {
    const h = await harness();
    const organizationId = await h.makeOrganization({
      name: 'Sample Agency',
      typeCode: 'federal_agency',
      levelCode: 'federal',
    });
    const personId = await h.addPerson(
      organizationId,
      'Jane Smith',
      'Director',
      'jane.smith@agency.example.gov',
    );

    const result = await h.compliance.recordComplaint({
      channel: 'email',
      contactType: 'email',
      contactValue: 'jane.smith@agency.example.gov',
      reason: 'asked to be removed',
      createdBy: 'ops',
    });

    expect(result.resolution).toBe('suppressed');
    const entries = await h.compliance.loadActiveSuppressions();
    const person = entries.find((entry) => entry.scope === 'person');
    expect(person?.personId).toBe(personId);
  });

  it('records a phone complaint for review rather than crashing', async () => {
    // The old path built a person-scope entry with a null person id, which the
    // schema rejects, and it did so before writing the complaint, so the
    // complaint was lost along with the error.
    const h = await harness();
    const result = await h.compliance.recordComplaint({
      channel: 'phone',
      contactType: 'phone',
      contactValue: '(555) 010-9999',
      reason: 'called and asked to be removed',
      createdBy: 'ops',
    });

    expect(result.complaintId).toBeTruthy();
    expect(result.resolution).toBe('needs_review');
    expect(result.suppressionEntryId).toBeNull();
    expect(result.reviewReason).toContain('cannot be matched');
    expect(await h.database.count('complaints')).toBe(1);
    expect(await h.database.count('suppression_entries')).toBe(0);
  });

  it('records a postal complaint for review rather than discarding it', async () => {
    const h = await harness();
    const result = await h.compliance.recordComplaint({
      channel: 'mail',
      contactType: 'postal',
      contactValue: '1 Example Plaza, Springfield',
      reason: 'wrote in asking to be removed',
      createdBy: 'ops',
    });

    expect(result.resolution).toBe('needs_review');
    expect(result.suppressionEntryId).toBeNull();
    const queue = await h.compliance.complaintReviewQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.channel).toBe('mail');
  });

  it('suppresses a phone complaint once the published number identifies someone', async () => {
    const h = await harness();
    const organizationId = await h.makeOrganization({
      name: 'Sample Agency',
      typeCode: 'federal_agency',
      levelCode: 'federal',
    });
    const personId = await h.addPerson(
      organizationId,
      'Ray Patel',
      'Analyst',
      'ray.patel@agency.example.gov',
    );
    await h.ingestion.ingestPerson({
      ...personInput(
        organizationId,
        h.documentId,
        'Ray Patel',
        'Analyst',
        'ray.patel@agency.example.gov',
      ),
      contactPoints: [
        {
          contactPointTypeCode: 'work_phone',
          value: '(555) 010-4242',
          valueNormalized: '5550104242',
          sourceValue: '(555) 010-4242',
        },
      ],
    });

    const result = await h.compliance.recordComplaint({
      channel: 'phone',
      contactType: 'phone',
      contactValue: '555-010-4242',
      reason: 'called and asked to be removed',
      createdBy: 'ops',
    });

    expect(result.resolution).toBe('suppressed');
    const entries = await h.compliance.loadActiveSuppressions();
    expect(entries.find((entry) => entry.scope === 'person')?.personId).toBe(personId);
  });

  it('never writes a person suppression without a person', async () => {
    const h = await harness();
    for (const contactType of ['phone', 'postal', 'fax', '']) {
      await h.compliance.recordComplaint({
        channel: 'other',
        contactType,
        contactValue: 'something unmatched',
        reason: 'asked to be removed',
        createdBy: 'ops',
      });
    }
    const orphaned = await h.database.count(
      'suppression_entries',
      "scope = 'person' and person_id is null",
    );
    expect(orphaned).toBe(0);
  });

  it('keeps the complaint and its suppression in one transaction', async () => {
    const h = await harness();
    const before = await h.database.count('complaints');
    await expect(
      h.compliance.recordComplaint({
        channel: 'email',
        contactType: 'email',
        // A scope the suppression table will reject, forcing a rollback.
        contactValue: '',
        reason: '',
        createdBy: 'ops',
        personId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow();
    expect(await h.database.count('complaints')).toBe(before);
  });

  it('lets a suppression be revoked exactly once, with a reason', async () => {
    const h = await harness();
    const id = await h.compliance.addSuppression({
      scope: 'email',
      value: 'jane@x.example.gov',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    await h.compliance.revokeSuppression(id, 'withdrawn by the person', 'ops');

    const row = await h.database.query<{ revoked_at: string; revoked_reason: string }>(
      'select revoked_at, revoked_reason from suppression_entries where id = $1',
      [id],
    );
    expect(row.rows[0]?.revoked_at).not.toBeNull();
    expect(row.rows[0]?.revoked_reason).toBe('withdrawn by the person');
  });

  it('refuses to un-revoke a suppression, even in raw SQL', async () => {
    const h = await harness();
    const id = await h.compliance.addSuppression({
      scope: 'email',
      value: 'jane@x.example.gov',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    await h.compliance.revokeSuppression(id, 'withdrawn', 'ops');

    await expect(
      h.database.query('update suppression_entries set revoked_at = null where id = $1', [id]),
    ).rejects.toThrow(/cannot be un-revoked/);
  });

  it('refuses to move a revocation to a different time, even in raw SQL', async () => {
    const h = await harness();
    const id = await h.compliance.addSuppression({
      scope: 'email',
      value: 'jane@x.example.gov',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    await h.compliance.revokeSuppression(id, 'withdrawn', 'ops');

    await expect(
      h.database.query(
        `update suppression_entries set revoked_at = now() + interval '1 day' where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/revoked_at cannot be changed/);
    await expect(
      h.database.query(
        `update suppression_entries set revoked_reason = 'something else' where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/revoked_reason cannot be changed/);
  });

  it('refuses a revocation with no reason', async () => {
    const h = await harness();
    const id = await h.compliance.addSuppression({
      scope: 'email',
      value: 'jane@x.example.gov',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    await expect(
      h.database.query('update suppression_entries set revoked_at = now() where id = $1', [id]),
    ).rejects.toThrow(/must record why/);
  });

  it('writes an audit event for a revocation, whichever path made it', async () => {
    const h = await harness();
    const id = await h.compliance.addSuppression({
      scope: 'email',
      value: 'jane@x.example.gov',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    // Raw SQL, deliberately: the audit event comes from the database, so it
    // cannot be skipped by writing around the repository.
    await h.database.query(
      `update suppression_entries set revoked_at = now(), revoked_reason = 'raw sql' where id = $1`,
      [id],
    );
    const events = await h.database.query<{ action: string }>(
      `select action from audit_events where entity_id = $1 order by occurred_at`,
      [id],
    );
    expect(events.rows.map((row) => row.action)).toContain('suppression.revoked');
  });

  it('refuses to delete a person an opt-out still names', async () => {
    const h = await harness();
    const organizationId = await h.makeOrganization({
      name: 'Sample Agency',
      typeCode: 'federal_agency',
      levelCode: 'federal',
    });
    const personId = await h.addPerson(
      organizationId,
      'Jane Smith',
      'Director',
      'jane.smith@agency.example.gov',
    );
    await h.compliance.addSuppression({
      scope: 'person',
      value: personId,
      personId,
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });

    // A cascade here would delete the opt-out along with the person, which is
    // the one outcome suppression exists to prevent.
    await expect(
      h.database.query('delete from people where id = $1', [personId]),
    ).rejects.toThrow();
    expect(await h.database.count('suppression_entries')).toBe(1);
  });

  it('will not let a suppression entry be edited or deleted', async () => {
    const h = await harness();
    const id = await h.compliance.addSuppression({
      scope: 'email',
      value: 'jane@x.example.gov',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    await expect(
      h.database.query('update suppression_entries set reason = $2 where id = $1', [id, 'changed']),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.database.query('delete from suppression_entries where id = $1', [id]),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('allows revocation and drops the entry from the active set', async () => {
    const h = await harness();
    const id = await h.compliance.addSuppression({
      scope: 'email',
      value: 'jane@x.example.gov',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    await h.compliance.revokeSuppression(id, 'confirmed in error', 'ops');
    expect(await h.compliance.loadActiveSuppressions()).toHaveLength(0);
    expect(await h.database.count('suppression_entries')).toBe(1);
  });

  it('rejects a suppression entry that names nothing', async () => {
    const h = await harness();
    await expect(
      h.database.query(
        `insert into suppression_entries (scope, value, reason, source, created_by)
         values ('organization','','no target','manual_review','ops')`,
      ),
    ).rejects.toThrow();
  });

  it('keeps the audit trail append-only and verifiable', async () => {
    const h = await harness();
    await h.compliance.addSuppression({
      scope: 'email',
      value: 'a@x.example.gov',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    await h.compliance.addSuppression({
      scope: 'email',
      value: 'b@x.example.gov',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
    });
    expect(await h.compliance.verifyAuditChain()).toEqual({ valid: true, brokenAtId: null });
    await expect(h.database.query('delete from audit_events')).rejects.toThrow(/append-only/);
  });
});

describe('QueryRepository and ExportRepository', () => {
  it('excludes suppressed people in SQL, before any export code runs', async () => {
    const h = await harness();
    const org = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    await h.addPerson(org, 'Jane Smith', 'Program Analyst', 'jane.smith@agency.example.gov');
    await h.addPerson(org, 'Wei Chen', 'Contract Specialist', 'wei.chen@agency.example.gov');

    expect(await h.queries.queryExportableRows(AT, PURPOSE)).toHaveLength(2);

    await h.compliance.addSuppression({
      scope: 'email',
      value: 'wei.chen@agency.example.gov',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
      effectiveAt: EFFECTIVE_FROM,
    });
    const rows = await h.queries.queryExportableRows(AT, PURPOSE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publishedEmail).toBe('jane.smith@agency.example.gov');
  });

  it('applies an organization-subtree opt-out down the whole tree, in SQL', async () => {
    const h = await harness();
    const dept = await h.makeOrganization({
      name: 'Department',
      typeCode: 'federal_department',
      levelCode: 'federal',
    });
    const bureau = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    const office = await h.makeOrganization({
      name: 'Field Office',
      typeCode: 'federal_field_office',
      levelCode: 'federal',
    });
    const unrelated = await h.makeOrganization({
      name: 'County',
      typeCode: 'county_government',
      levelCode: 'county',
    });
    await h.relate(dept, bureau);
    await h.relate(bureau, office);

    await h.addPerson(dept, 'Dana Ito', 'Deputy Director', 'dana.ito@agency.example.gov');
    await h.addPerson(bureau, 'Jane Smith', 'Program Analyst', 'jane.smith@agency.example.gov');
    await h.addPerson(office, 'Omar Farouk', 'Special Agent', 'omar.farouk@agency.example.gov');
    await h.addPerson(unrelated, 'Rosa Delgado', 'Clerk', 'rosa.delgado@county.example.org');

    expect(await h.queries.queryExportableRows(AT, PURPOSE)).toHaveLength(4);

    await h.compliance.addSuppression({
      scope: 'organization_subtree',
      value: dept,
      organizationId: dept,
      reason: 'the department asked not to be contacted',
      source: 'opt_out_request',
      createdBy: 'ops',
      effectiveAt: EFFECTIVE_FROM,
    });

    const rows = await h.queries.queryExportableRows(AT, PURPOSE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationName).toBe('County');
  });

  it('carries the ancestry needed for the in-memory re-check', async () => {
    const h = await harness();
    const dept = await h.makeOrganization({
      name: 'Department',
      typeCode: 'federal_department',
      levelCode: 'federal',
    });
    const bureau = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    await h.relate(dept, bureau);
    await h.addPerson(bureau, 'Jane Smith', 'Program Analyst', 'jane.smith@agency.example.gov');

    const rows = await h.queries.queryExportableRows(AT, PURPOSE);
    expect(rows[0]?.organizationAncestorIds).toEqual([dept]);
    expect(rows[0]?.parentOrganizationName).toBe('Department');
  });

  it('suppresses an entire level of government', async () => {
    const h = await harness();
    const bureau = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    const county = await h.makeOrganization({
      name: 'County',
      typeCode: 'county_government',
      levelCode: 'county',
    });
    await h.addPerson(bureau, 'Jane Smith', 'Program Analyst', 'jane.smith@agency.example.gov');
    await h.addPerson(county, 'Rosa Delgado', 'Clerk', 'rosa.delgado@county.example.org');

    await h.compliance.addSuppression({
      scope: 'government_level',
      value: 'federal',
      governmentLevelCode: 'federal',
      reason: 'policy hold',
      source: 'policy',
      createdBy: 'ops',
      effectiveAt: EFFECTIVE_FROM,
    });
    const rows = await h.queries.queryExportableRows(AT, PURPOSE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.governmentLevelCode).toBe('county');
  });

  it('suppresses one declared purpose without suppressing the record everywhere', async () => {
    const h = await harness();
    const org = await h.makeOrganization({
      name: 'County',
      typeCode: 'county_government',
      levelCode: 'county',
    });
    await h.addPerson(org, 'Rosa Delgado', 'Clerk', 'rosa.delgado@county.example.org');

    await h.compliance.addSuppression({
      scope: 'export_purpose',
      value: 'outreach',
      exportPurpose: 'outreach',
      reason: 'not approved for outreach',
      source: 'policy',
      createdBy: 'ops',
      effectiveAt: EFFECTIVE_FROM,
    });
    expect(await h.queries.queryExportableRows(AT, 'outreach')).toHaveLength(0);
    expect(await h.queries.queryExportableRows(AT, 'internal-review')).toHaveLength(1);
  });

  it('builds an export, records the suppression check and audits it', async () => {
    const h = await harness();
    const org = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    await h.addPerson(org, 'Jane Smith', 'Program Analyst', 'jane.smith@agency.example.gov');
    await h.addPerson(org, 'Wei Chen', 'Contract Specialist', 'wei.chen@agency.example.gov');
    await h.compliance.addSuppression({
      scope: 'email',
      value: 'wei.chen@agency.example.gov',
      reason: 'opt out',
      source: 'opt_out_request',
      createdBy: 'ops',
      effectiveAt: EFFECTIVE_FROM,
    });

    const exports = new ExportRepository(h.database);
    const built = await exports.buildPeopleExport({
      name: 'federal-sample',
      requestedBy: 'ops',
      purpose: PURPOSE,
      filters: { governmentLevelCode: 'federal' },
    });

    expect(built.rowCount).toBe(1);
    expect(built.csv).toContain('jane.smith@agency.example.gov');
    expect(built.csv).not.toContain('wei.chen@agency.example.gov');

    const row = await h.database.query<{
      status: string;
      purpose: string;
      suppression_checked_at: Date | null;
    }>('select status, purpose, suppression_checked_at from exports where id = $1', [
      built.exportId,
    ]);
    expect(row.rows[0]?.status).toBe('completed');
    expect(row.rows[0]?.purpose).toBe(PURPOSE);
    expect(row.rows[0]?.suppression_checked_at).not.toBeNull();
    expect(await h.database.count('audit_events', "action = 'export.completed'")).toBe(1);
  });

  it('a person suppressed after a previous export is absent from the next one', async () => {
    const h = await harness();
    const org = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    await h.addPerson(org, 'Jane Smith', 'Program Analyst', 'jane.smith@agency.example.gov');
    const exports = new ExportRepository(h.database);

    expect(
      (
        await exports.buildPeopleExport({
          name: 'a',
          requestedBy: 'ops',
          purpose: PURPOSE,
          filters: {},
        })
      ).rowCount,
    ).toBe(1);
    await h.compliance.addSuppression({
      scope: 'email',
      value: 'jane.smith@agency.example.gov',
      reason: 'opt out',
      source: 'complaint',
      createdBy: 'ops',
    });
    const second = await exports.buildPeopleExport({
      name: 'b',
      requestedBy: 'ops',
      purpose: PURPOSE,
      filters: {},
    });
    expect(second.rowCount).toBe(0);
  });

  it('filters to an organization subtree when asked', async () => {
    const h = await harness();
    const dept = await h.makeOrganization({
      name: 'Department',
      typeCode: 'federal_department',
      levelCode: 'federal',
    });
    const bureau = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    const county = await h.makeOrganization({
      name: 'County',
      typeCode: 'county_government',
      levelCode: 'county',
    });
    await h.relate(dept, bureau);
    await h.addPerson(bureau, 'Jane Smith', 'Program Analyst', 'jane.smith@agency.example.gov');
    await h.addPerson(county, 'Rosa Delgado', 'Clerk', 'rosa.delgado@county.example.org');

    const rows = await h.queries.queryExportableRows(AT, PURPOSE, {
      organizationId: dept,
      includeOrganizationSubtree: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationName).toBe('Bureau');
  });

  it('reports coverage across levels of government', async () => {
    const h = await harness();
    const bureau = await h.makeOrganization({
      name: 'Bureau',
      typeCode: 'federal_bureau',
      levelCode: 'federal',
    });
    await h.makeOrganization({
      name: 'County',
      typeCode: 'county_government',
      levelCode: 'county',
    });
    await h.addPerson(bureau, 'Jane Smith', 'Program Analyst', 'jane.smith@agency.example.gov');

    const all = await h.queries.coverageSummary();
    expect(all).toMatchObject({
      organizations: 2,
      governmentLevels: 2,
      people: 1,
      publishedEmails: 1,
    });

    const federalOnly = await h.queries.coverageSummary({ governmentLevelCode: 'federal' });
    expect(federalOnly.organizations).toBe(1);
  });
});
