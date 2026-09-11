import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  ComplianceRepository,
  ExportPurposeRepository,
  IngestionRepository,
  OrganizationRepository,
  QueryRepository,
  TestDatabase,
} from '@public-workforce/database';
import { educationSectorPack } from '@public-workforce/sector-education';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TexasEducationOrganizationIndex,
  prepareLegacyContact,
  streamLegacyContactLines,
} from './legacy-contact-import.js';
import {
  importPreparedLegacyContact,
  recordLegacyArtifact,
  seedLegacyRevalidationTarget,
} from './legacy-contact-persistence.js';

const OBSERVED_AT = '2026-09-11T17:05:13.503Z';
const ARTIFACT_CREATED_AT = '2026-09-11T19:13:35.000Z';
const SOURCE_PAGE_URL = 'https://www.killeenisd.org/o/dousees/staff?page_no=2';
const PURPOSE = 'legacy-import-fixture';

let open: TestDatabase | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

describe('Texas legacy contact persistence', () => {
  it('imports gzip evidence idempotently and preserves suppression and target provenance', async () => {
    const database = await TestDatabase.create({ sectors: [educationSectorPack] });
    open = database;
    const ingestion = new IngestionRepository(database);
    const organizations = new OrganizationRepository(database);
    const spineSource = await ingestion.recordSourceDocument({
      url: 'https://fixture.example/texas-school-spine',
      urlCanonical: 'https://fixture.example/texas-school-spine',
      urlHash: 'fixture-texas-school-spine',
      domain: 'fixture.example',
      sourceTypeCode: 'bulk_dataset',
      httpStatus: 200,
      contentHash: 'fixture-texas-school-spine-content',
      contentType: 'application/x-ndjson',
      storageKey: null,
      robotsAllowed: true,
      robotsPolicyNote: null,
      sourcePolicyId: null,
      crawlRunId: null,
      retrievedAt: OBSERVED_AT,
    });
    const jurisdictionId = await organizations.upsertJurisdiction({
      code: 'us-tx-education',
      name: 'Texas education',
      governmentLevelCode: 'special_district',
    });
    const district = await organizations.upsertOrganization({
      organizationTypeCode: 'school_district',
      governmentLevelCode: 'special_district',
      sectorCode: 'education',
      jurisdictionId,
      name: 'Killeen Independent School District',
      nameNormalized: 'killeen-independent-school-district',
      primaryDomain: 'killeenisd.org',
      sourceDocumentId: spineSource.documentId,
      extractionMethod: 'manual',
      confidence: 1,
      observedAt: OBSERVED_AT,
    });
    const school = await organizations.upsertOrganization({
      organizationTypeCode: 'school',
      governmentLevelCode: 'special_district',
      sectorCode: 'education',
      jurisdictionId,
      parentOrganizationId: district.id,
      name: 'Alice W Douse Elementary School',
      nameNormalized: 'alice-w-douse-elementary-school',
      primaryDomain: 'killeenisd.org',
      sourceDocumentId: spineSource.documentId,
      extractionMethod: 'manual',
      confidence: 1,
      observedAt: OBSERVED_AT,
    });
    await organizations.upsertRelationship({
      parentOrganizationId: district.id,
      childOrganizationId: school.id,
      relationshipTypeCode: 'part_of',
      effectiveFrom: '2026-01-01',
      sourceDocumentId: spineSource.documentId,
      extractionMethod: 'manual',
      confidence: 1,
      observedAt: OBSERVED_AT,
    });

    const raw = {
      record_id: 'fixture-record-1',
      state_published: 'Texas',
      district: 'Killeen Isd',
      school: 'Alice W Douse El',
      directory_url: SOURCE_PAGE_URL,
      full_name: 'Abigail Gracia-Cruz',
      title: 'Teacher Associate Kindergarten',
      department: '',
      email: 'abigail.graciacruz@killeenisd.org',
      email_source: 'Published mailto on human-viewable staff page',
      collected_at_utc: OBSERVED_AT,
      canonical_source_row: 17,
      canonical_campus_key: 'killeen-isd:alice-w-douse-el',
      qa_identity_method: 'exact_school_and_district',
      source_dataset: 'batch2',
      organization_website_published: 'https://www.killeenisd.org/o/dousees',
      location_published: 'Alice W Douse Elementary School',
      city_published: 'Killeen',
      county_published: 'Bell',
      grade_range_published: 'PK-5',
      context: 'this raw context must never be persisted',
    };
    const directory = await fs.mkdtemp(join(tmpdir(), 'legacy-contact-persistence-'));
    const artifactPath = join(directory, 'accepted_contacts.jsonl.gz');
    try {
      await fs.writeFile(artifactPath, gzipSync(`${JSON.stringify(raw)}\n`));
      const streamed = [];
      for await (const item of streamLegacyContactLines(artifactPath)) streamed.push(item);
      expect(streamed).toHaveLength(1);
      const disposition = prepareLegacyContact(
        JSON.parse(streamed[0]!.line) as Record<string, unknown>,
        new TexasEducationOrganizationIndex([
          {
            organizationId: school.id,
            districtName: 'Killeen Independent School District',
            schoolName: 'Alice W Douse Elementary School',
          },
        ]),
        'fixture-artifact',
        streamed[0]!.lineNumber,
        new Set(['killeenisd.org']),
      );
      expect(disposition.status).toBe('accepted');
      if (disposition.status !== 'accepted') throw new Error(disposition.reason);

      const artifact = await recordLegacyArtifact(
        database,
        {
          path: 'accepted_contacts.jsonl.gz',
          sha256: 'a'.repeat(64),
          archiveStorageKey: 'fixtures/accepted_contacts.jsonl.gz',
        },
        'fixture-artifact',
        'a'.repeat(64),
        ARTIFACT_CREATED_AT,
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await database.transaction(async (tx) => {
          await importPreparedLegacyContact(tx, disposition.record, artifact, {
            artifactId: 'fixture-artifact',
            archiveReference: 'fixtures/accepted_contacts.jsonl.gz',
            sha256: 'a'.repeat(64),
          });
          await seedLegacyRevalidationTarget(tx, disposition.record, artifact.documentId);
        });
      }

      expect(await database.count('people')).toBe(1);
      expect(await database.count('employment_assignments')).toBe(1);
      expect(await database.count('email_addresses')).toBe(1);
      expect(await database.count('crawl_targets')).toBe(1);
      expect(await database.count('crawl_target_organizations')).toBe(1);
      const artifactVersion = await database.query<{
        content_type: string;
        storage_key: string;
        retrieved_at: Date;
      }>(
        `select content_type, storage_key, retrieved_at
         from source_document_versions where id = $1`,
        [artifact.versionId],
      );
      expect(artifactVersion.rows[0]).toMatchObject({
        content_type: 'application/gzip',
        storage_key: 'fixtures/accepted_contacts.jsonl.gz',
      });
      expect(artifactVersion.rows[0]?.retrieved_at.toISOString()).toBe(ARTIFACT_CREATED_AT);
      expect(await database.count('source_documents', 'url = $1', [SOURCE_PAGE_URL])).toBe(0);
      for (const table of ['people', 'employment_assignments', 'email_addresses']) {
        const provenance = await database.query<{ source_document_id: string }>(
          `select source_document_id from ${table}`,
        );
        expect(provenance.rows[0]?.source_document_id).toBe(artifact.documentId);
      }
      const association = await database.query<{ source_document_id: string }>(
        'select source_document_id from crawl_target_organizations',
      );
      expect(association.rows[0]?.source_document_id).toBe(artifact.documentId);
      const sourcePage = await database.query<{
        record_key: string;
        source_document_version_id: string;
        value_normalized: string;
      }>(
        `select record_key, source_document_version_id, value_normalized
         from source_observations where field = 'source_page_url'`,
      );
      expect(sourcePage.rows).toEqual([
        expect.objectContaining({
          record_key: disposition.record.recordKey,
          source_document_version_id: artifact.versionId,
          value_normalized: SOURCE_PAGE_URL,
        }),
      ]);
      expect(
        await database.count(
          'source_observations',
          "field = 'legacy_artifact_sha256' and value_normalized = $1",
          ['a'.repeat(64)],
        ),
      ).toBe(1);
      const canonicalMetadata = await database.query<{ field: string; value_normalized: string }>(
        `select field, value_normalized from source_observations
         where field in ('canonical_source_row','canonical_campus_key') order by field`,
      );
      expect(canonicalMetadata.rows).toEqual([
        {
          field: 'canonical_campus_key',
          value_normalized: 'killeen-isd:alice-w-douse-el',
        },
        { field: 'canonical_source_row', value_normalized: '17' },
      ]);
      expect(await database.count('source_observations', "field = 'context'")).toBe(0);

      await new ExportPurposeRepository(database).approve({
        code: PURPOSE,
        description: 'Verify legacy fixture export behavior.',
        owner: 'test',
        approvedBy: 'test',
        approvedAt: ARTIFACT_CREATED_AT,
      });
      const queries = new QueryRepository(database);
      const beforeSuppression = await queries.queryExportableRows(
        '2026-09-12T00:00:00.000Z',
        PURPOSE,
        { sectorCode: 'education' },
      );
      expect(beforeSuppression).toHaveLength(1);
      expect(beforeSuppression[0]?.publishedEmails).toEqual([
        expect.objectContaining({
          sourceDocumentId: artifact.documentId,
          sourceUrl: SOURCE_PAGE_URL,
          sourceDataset: 'batch2',
          sourceFile: 'batch2',
          sourceLine: '17',
          organizationWebsitePublished: 'https://www.killeenisd.org/o/dousees',
          locationPublished: 'Alice W Douse Elementary School',
          cityPublished: 'Killeen',
          countyPublished: 'Bell',
          statePublished: 'Texas',
          gradeRangePublished: 'PK-5',
        }),
      ]);
      await new ComplianceRepository(database).addSuppression({
        scope: 'source',
        value: artifact.documentId,
        sourceDocumentId: artifact.documentId,
        reason: 'fixture source suppression',
        source: 'opt_out_request',
        effectiveAt: ARTIFACT_CREATED_AT,
        createdBy: 'test',
      });
      expect(
        await queries.queryExportableRows('2026-09-12T00:00:00.000Z', PURPOSE, {
          sectorCode: 'education',
        }),
      ).toHaveLength(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
