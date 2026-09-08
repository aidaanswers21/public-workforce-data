import { afterEach, describe, expect, it } from 'vitest';
import { TestDatabase } from '../testing.js';
import { educationSectorPack } from '@public-workforce/sector-education';
import { stateLocalGovernmentSectorPack } from '@public-workforce/sector-state-local';
import { OrganizationSpineImportRepository } from './spine-import.js';
import { OrganizationRepository } from './organizations.js';

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.close();
  database = null;
});

describe('organization spine import repository', () => {
  it('stages provenance-bearing rows in batches and canonicalizes only ready records', async () => {
    database = await TestDatabase.create({ sectors: [stateLocalGovernmentSectorPack] });
    const document = await database.query<{ id: string }>(
      `insert into source_documents (
         url, url_canonical, url_hash, domain, source_type_code
       ) values (
         'https://example.test/official-release', 'https://example.test/official-release',
         'spine-import-test-source', 'example.test', 'bulk_dataset'
       ) returning id`,
    );
    const sourceDocumentId = document.rows[0]?.id ?? '';
    const version = await database.query<{ id: string }>(
      `insert into source_document_versions (
         source_document_id, version, content_hash, http_status, content_type
       ) values ($1,1,'fixture-spine-content',200,'application/x-ndjson') returning id`,
      [sourceDocumentId],
    );
    const sourceDocumentVersionId = version.rows[0]?.id ?? '';
    const repository = new OrganizationSpineImportRepository(database);
    const observedAt = '2026-09-07T18:31:42.955Z';

    expect(
      await repository.stage([
        {
          sourceKey: 'fixture-official-universe',
          sourceRecordKey: 'ready-1',
          name: 'Fixture Department',
          nameNormalized: 'fixture-department',
          organizationTypeCode: 'state_department',
          governmentLevelCode: 'state',
          sectorCode: 'general_government',
          classificationReviewReason: null,
          jurisdictionId: null,
          websiteValueRaw: 'department.example.test',
          websiteUrl: 'https://department.example.test/',
          primaryDomain: 'department.example.test',
          identifiers: [
            { systemCode: 'census_government_id', value: 'FIXTURE-1', issuingStateCode: 'CO' },
          ],
          parentIdentifiers: [],
          location: {
            addressLine1: '100 Public Way',
            city: 'Example',
            stateCode: 'CO',
            postalCode: '80000',
          },
          attributes: { publishedStatus: 'Active' },
          status: 'ready_to_import',
          sourceDocumentId,
          sourceDocumentVersionId,
          sourceEffectiveDate: '2026-09-01',
          observedAt,
        },
        {
          sourceKey: 'fixture-official-universe',
          sourceRecordKey: 'held-1',
          name: 'Unclassified Fixture Body',
          nameNormalized: 'unclassified-fixture-body',
          organizationTypeCode: null,
          governmentLevelCode: null,
          sectorCode: null,
          classificationReviewReason: 'Authoritative classification is not available.',
          jurisdictionId: null,
          websiteValueRaw: null,
          websiteUrl: null,
          primaryDomain: null,
          identifiers: [],
          parentIdentifiers: [],
          location: { stateCode: 'CO' },
          attributes: {},
          status: 'classification_hold',
          sourceDocumentId,
          sourceDocumentVersionId,
          sourceEffectiveDate: '2026-09-01',
          observedAt,
        },
      ]),
    ).toBe(2);

    expect(await repository.summary()).toMatchObject({
      staged: 2,
      readyToImport: 1,
      imported: 0,
      classificationHolds: 1,
    });
    expect(await repository.canonicalizeReady()).toBe(1);
    expect(await repository.canonicalizeReady()).toBe(0);
    expect(await repository.summary()).toMatchObject({
      staged: 2,
      readyToImport: 0,
      imported: 1,
      classificationHolds: 1,
    });
    expect(await database.count('organizations')).toBe(1);
    expect(await database.count('external_identifiers')).toBe(1);
    expect(await database.count('organization_locations')).toBe(1);

    expect(
      await repository.stage([
        {
          sourceKey: 'fixture-official-universe',
          sourceRecordKey: 'held-1',
          name: 'Formerly Unclassified Fixture Body',
          nameNormalized: 'formerly-unclassified-fixture-body',
          organizationTypeCode: 'state_department',
          governmentLevelCode: 'state',
          sectorCode: 'general_government',
          classificationReviewReason: null,
          jurisdictionId: null,
          websiteValueRaw: null,
          websiteUrl: null,
          primaryDomain: null,
          identifiers: [
            { systemCode: 'census_government_id', value: 'FIXTURE-2', issuingStateCode: 'CO' },
          ],
          parentIdentifiers: [],
          location: { stateCode: 'CO' },
          attributes: {},
          status: 'ready_to_import',
          sourceDocumentId,
          sourceDocumentVersionId,
          sourceEffectiveDate: '2026-09-01',
          observedAt: '2026-09-08T12:00:00.000Z',
        },
      ]),
    ).toBe(1);
    expect(await repository.canonicalizeReady()).toBe(1);
    expect(await database.count('organizations')).toBe(2);
  });

  it('refuses oversized batches and invalid canonicalization limits', async () => {
    database = await TestDatabase.create();
    const repository = new OrganizationSpineImportRepository(database);

    await expect(repository.canonicalizeReady(0)).rejects.toThrow(/between 1 and 5000/);
    await expect(repository.stage(new Array(5_001).fill({}))).rejects.toThrow(/exceeds 5000/);
  });

  it('links every exact identifier, carries jurisdiction, and materializes hierarchy', async () => {
    database = await TestDatabase.create({ sectors: [educationSectorPack] });
    const organizations = new OrganizationRepository(database);
    const jurisdictionId = await organizations.upsertJurisdiction({
      code: 'fixture-education',
      name: 'Fixture education',
      governmentLevelCode: 'special_district',
    });
    const source = await database.query<{ id: string }>(
      `insert into source_documents (
         url, url_canonical, url_hash, domain, source_type_code
       ) values (
         'https://example.test/release', 'https://example.test/release',
         'spine-exact-source', 'example.test', 'bulk_dataset'
       ) returning id`,
    );
    const sourceDocumentId = source.rows[0]?.id ?? '';
    const version = await database.query<{ id: string }>(
      `insert into source_document_versions (
         source_document_id, version, content_hash, http_status, content_type
       ) values ($1,1,'spine-exact-version',200,'application/x-ndjson') returning id`,
      [sourceDocumentId],
    );
    const sourceDocumentVersionId = version.rows[0]?.id ?? '';
    const repository = new OrganizationSpineImportRepository(database);
    const common = {
      governmentLevelCode: 'special_district',
      sectorCode: 'education',
      classificationReviewReason: null,
      jurisdictionId,
      location: { city: 'Example', stateCode: 'TX' },
      attributes: {},
      status: 'ready_to_import' as const,
      sourceDocumentId,
      sourceDocumentVersionId,
      sourceEffectiveDate: '2026-09-01',
      observedAt: '2026-09-08T12:00:00.000Z',
    };

    await repository.stage([
      {
        ...common,
        sourceKey: 'fixture-national',
        sourceRecordKey: '4812345',
        name: 'Fixture District',
        nameNormalized: 'fixture-district',
        organizationTypeCode: 'school_district',
        jurisdictionId: null,
        websiteValueRaw: null,
        websiteUrl: null,
        primaryDomain: null,
        identifiers: [{ systemCode: 'nces_district_id', value: '4812345', issuingStateCode: null }],
        parentIdentifiers: [],
      },
    ]);
    expect(await repository.canonicalizeReady()).toBe(1);

    await repository.stage([
      {
        ...common,
        sourceKey: 'fixture-state-overlay',
        sourceRecordKey: 'district:001234',
        name: 'Fixture Independent School District',
        nameNormalized: 'fixture-independent-school-district',
        organizationTypeCode: 'school_district',
        websiteValueRaw: 'www.fixture.example',
        websiteUrl: 'https://www.fixture.example/',
        primaryDomain: 'fixture.example',
        identifiers: [
          { systemCode: 'state_education_org_id', value: '001234', issuingStateCode: 'TX' },
          { systemCode: 'nces_district_id', value: '4812345', issuingStateCode: null },
        ],
        parentIdentifiers: [],
      },
      {
        ...common,
        sourceKey: 'fixture-state-overlay',
        sourceRecordKey: 'school:001234001',
        name: 'Fixture School',
        nameNormalized: 'fixture-school',
        organizationTypeCode: 'school',
        websiteValueRaw: null,
        websiteUrl: null,
        primaryDomain: null,
        identifiers: [
          { systemCode: 'nces_school_id', value: '481234500001', issuingStateCode: null },
          {
            systemCode: 'state_education_org_id',
            value: '001234001',
            issuingStateCode: 'TX',
          },
        ],
        parentIdentifiers: [
          { systemCode: 'state_education_org_id', value: '001234', issuingStateCode: 'TX' },
          { systemCode: 'nces_district_id', value: '4812345', issuingStateCode: null },
        ],
      },
    ]);
    expect(await repository.canonicalizeReady()).toBe(2);
    expect(await database.count('organizations')).toBe(2);
    expect(await database.count('external_identifiers')).toBe(4);
    expect(await database.count('source_observations')).toBe(4);

    const district = await database.query<{
      jurisdiction_id: string;
      website_url: string;
      source_records: number;
    }>(
      `select organization.jurisdiction_id, organization.website_url,
              count(record.id)::int as source_records
       from organizations organization
       join organization_spine_records record on record.organization_id = organization.id
       where organization.organization_type_code = 'school_district'
       group by organization.id`,
    );
    expect(district.rows[0]).toEqual({
      jurisdiction_id: jurisdictionId,
      website_url: 'https://www.fixture.example/',
      source_records: 2,
    });

    expect(await repository.materializeRelationships('fixture-state-overlay')).toEqual({
      materialized: 1,
      unresolved: 0,
    });
    expect(await database.count('organization_relationships')).toBe(1);
  });

  it('scopes state-issued identifiers by issuing state', async () => {
    database = await TestDatabase.create({ sectors: [educationSectorPack] });
    const source = await database.query<{ id: string }>(
      `insert into source_documents (
         url, url_canonical, url_hash, domain, source_type_code
       ) values (
         'https://example.test/state-ids', 'https://example.test/state-ids',
         'state-id-source', 'example.test', 'bulk_dataset'
       ) returning id`,
    );
    const sourceDocumentId = source.rows[0]?.id ?? '';
    const organizations = new OrganizationRepository(database);
    const base = {
      organizationTypeCode: 'school_district',
      governmentLevelCode: 'special_district',
      sectorCode: 'education',
      nameNormalized: 'fixture-district',
      sourceDocumentId,
      extractionMethod: 'bulk_import' as const,
      confidence: 1,
      observedAt: '2026-09-08T12:00:00.000Z',
    };
    await organizations.upsertOrganization({
      ...base,
      name: 'Texas Fixture District',
      identifier: {
        systemCode: 'state_education_org_id',
        value: '001234',
        issuingStateCode: 'TX',
      },
    });
    await organizations.upsertOrganization({
      ...base,
      name: 'Colorado Fixture District',
      nameNormalized: 'colorado-fixture-district',
      identifier: {
        systemCode: 'state_education_org_id',
        value: '001234',
        issuingStateCode: 'CO',
      },
    });

    expect(await database.count('organizations')).toBe(2);
    expect(await database.count('external_identifiers')).toBe(2);
    const fingerprints = await database.query<{ identity_fingerprint: string }>(
      'select identity_fingerprint from organizations order by identity_fingerprint',
    );
    expect(fingerprints.rows.map((row) => row.identity_fingerprint)).toEqual([
      'oid:state_education_org_id:CO:001234',
      'oid:state_education_org_id:TX:001234',
    ]);
  });
});
