import { afterEach, describe, expect, it } from 'vitest';
import { OrganizationSpineImportRepository, TestDatabase } from '@public-workforce/database';
import { educationSectorPack } from '@public-workforce/sector-education';
import {
  ensureTexasEducationJurisdiction,
  materializeTexasEducationAttributes,
  TEXAS_ASKTED_SOURCE_KEY,
} from './materialize.js';

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.close();
  database = null;
});

describe('Texas education spine materialization', () => {
  it('stores only unambiguous published education attributes', async () => {
    database = await TestDatabase.create({ sectors: [educationSectorPack] });
    const jurisdictionId = await ensureTexasEducationJurisdiction(database);
    const document = await database.query<{ id: string }>(
      `insert into source_documents (
         url, url_canonical, url_hash, domain, source_type_code
       ) values (
         'https://example.test/askted', 'https://example.test/askted',
         'askted-materialization-source', 'example.test', 'bulk_dataset'
       ) returning id`,
    );
    const sourceDocumentId = document.rows[0]?.id ?? '';
    const version = await database.query<{ id: string }>(
      `insert into source_document_versions (
         source_document_id, version, content_hash, http_status, content_type
       ) values ($1,1,'askted-materialization-version',200,'application/x-ndjson') returning id`,
      [sourceDocumentId],
    );
    const repository = new OrganizationSpineImportRepository(database);
    await repository.stage([
      {
        sourceKey: TEXAS_ASKTED_SOURCE_KEY,
        sourceRecordKey: 'school:001234001',
        name: 'Fixture School',
        nameNormalized: 'fixture-school',
        organizationTypeCode: 'school',
        governmentLevelCode: 'special_district',
        sectorCode: 'education',
        classificationReviewReason: null,
        jurisdictionId,
        websiteValueRaw: null,
        websiteUrl: null,
        primaryDomain: null,
        identifiers: [
          { systemCode: 'nces_school_id', value: '481234500001', issuingStateCode: null },
        ],
        parentIdentifiers: [],
        location: { stateCode: 'TX' },
        attributes: {
          lowGrade: '09',
          highGrade: '12',
          instructionType: 'REGULAR INSTRUCTIONAL',
          status: 'Active',
          charterType: '',
          magnetStatus: 'N',
          virtualStatus: 'Hybrid',
          enrollment: 425,
          enrollmentAsOf: '2025-10',
        },
        status: 'ready_to_import',
        sourceDocumentId,
        sourceDocumentVersionId: version.rows[0]?.id ?? '',
        sourceEffectiveDate: '2026-09-01',
        observedAt: '2026-09-08T12:00:00.000Z',
      },
    ]);
    expect(await repository.canonicalizeReady()).toBe(1);
    expect(await materializeTexasEducationAttributes(database)).toBe(1);

    const attributes = await database.query<Record<string, unknown>>(
      `select low_grade, high_grade, school_type, operational_status,
              is_charter, is_magnet, is_virtual, enrollment, enrollment_as_of,
              source_document_id
       from education_organization_attributes`,
    );
    expect(attributes.rows[0]).toEqual({
      low_grade: '09',
      high_grade: '12',
      school_type: 'REGULAR INSTRUCTIONAL',
      operational_status: 'Active',
      is_charter: null,
      is_magnet: false,
      is_virtual: null,
      enrollment: 425,
      enrollment_as_of: null,
      source_document_id: sourceDocumentId,
    });
  });
});
