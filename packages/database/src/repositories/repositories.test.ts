import { afterEach, describe, expect, it } from 'vitest';
import { parsePersonName, personIdentityKey } from '@pan/core';
import type { Uuid } from '@pan/shared-types';
import { educationSectorPack } from '@pan/sector-education';
import { federalGovernmentSectorPack } from '@pan/sector-federal';
import { stateLocalGovernmentSectorPack } from '@pan/sector-state-local';
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

  const documentId = await ingestion.upsertSourceDocument({
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
      levelCode: 'education',
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

  it('records observations idempotently, tagged with what they prove', async () => {
    const h = await harness();
    for (const evidenceClass of ['employment', 'employment']) {
      await h.ingestion.recordObservation({
        sourceDocumentId: h.documentId,
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
        sourceDocumentId: h.documentId,
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
  it('records a complaint and the suppression it creates', async () => {
    const h = await harness();
    const result = await h.compliance.recordComplaint({
      channel: 'email',
      contactType: 'email',
      contactValue: 'Jane.Smith@Agency.example.gov',
      reason: 'asked to be removed',
      createdBy: 'ops',
    });
    expect(result.suppressionEntryId).not.toBeNull();
    const entries = await h.compliance.loadActiveSuppressions();
    expect(entries[0]?.value).toBe('jane.smith@agency.example.gov');
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
