import { afterEach, describe, expect, it } from 'vitest';
import { TestDatabase } from '../testing.js';
import { stateLocalGovernmentSectorPack } from '@public-workforce/sector-state-local';
import { OrganizationSpineImportRepository } from './spine-import.js';

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
  });

  it('refuses oversized batches and invalid canonicalization limits', async () => {
    database = await TestDatabase.create();
    const repository = new OrganizationSpineImportRepository(database);

    await expect(repository.canonicalizeReady(0)).rejects.toThrow(/between 1 and 5000/);
    await expect(repository.stage(new Array(5_001).fill({}))).rejects.toThrow(/exceeds 5000/);
  });
});
