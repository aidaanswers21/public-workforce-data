import { afterEach, describe, expect, it } from 'vitest';
import type { Uuid } from '@public-workforce/shared-types';
import { TestDatabase } from '../testing.js';
import { IngestionRepository } from './ingestion.js';
import { OrganizationRepository } from './organizations.js';
import { WebsiteResolutionRepository } from './website-resolution.js';

const AT = '2026-09-07T12:00:00.000Z';
let open: TestDatabase | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

async function harness(): Promise<{
  database: TestDatabase;
  websites: WebsiteResolutionRepository;
  organizationId: Uuid;
  sourceDocumentId: Uuid;
  sourceDocumentVersionId: Uuid;
}> {
  const database = await TestDatabase.create();
  open = database;
  const ingestion = new IngestionRepository(database);
  const organizations = new OrganizationRepository(database);
  const source = await ingestion.recordSourceDocument({
    url: 'https://catalog.example.gov/organizations.csv',
    urlCanonical: 'https://catalog.example.gov/organizations.csv',
    urlHash: 'website-resolution-source',
    domain: 'catalog.example.gov',
    sourceTypeCode: 'bulk_dataset',
    httpStatus: 200,
    contentHash: 'website-resolution-content',
    contentType: 'text/csv',
    storageKey: null,
    robotsAllowed: null,
    robotsPolicyNote: null,
    crawlRunId: null,
    retrievedAt: AT,
  });
  const jurisdictionId = await organizations.upsertJurisdiction({
    code: 'example-locality',
    name: 'Example locality',
    governmentLevelCode: 'municipal',
  });
  const organization = await organizations.upsertOrganization({
    organizationTypeCode: 'municipality',
    governmentLevelCode: 'municipal',
    sectorCode: 'general_government',
    jurisdictionId,
    name: 'Example City',
    nameNormalized: 'example-city',
    sourceDocumentId: source.documentId,
    extractionMethod: 'file_import',
    confidence: 1,
    observedAt: AT,
    identifier: { systemCode: 'state_assigned_id', value: 'example-001' },
  });
  await database.query(
    `insert into organization_locations (
       organization_id, address_line1, city, state_code, postal_code, is_primary,
       source_document_id, extraction_method_code, confidence, first_seen_at, last_seen_at
     ) values ($1, '1 Main Street', 'Example', 'CO', '80000', true, $2, 'file_import', 1, $3, $3)`,
    [organization.id, source.documentId, AT],
  );
  return {
    database,
    websites: new WebsiteResolutionRepository(database),
    organizationId: organization.id,
    sourceDocumentId: source.documentId,
    sourceDocumentVersionId: source.versionId,
  };
}

describe('WebsiteResolutionRepository', () => {
  it('pages and filters the missing-website queue with identity and location evidence', async () => {
    const h = await harness();
    const queue = await h.websites.missingWebsiteQueue({
      stateCodes: ['CO'],
      governmentLevelCodes: ['municipal'],
      sectorCodes: ['general_government'],
    });

    expect(queue).toEqual([
      expect.objectContaining({
        id: h.organizationId,
        name: 'Example City',
        stateCode: 'CO',
        identifiers: [
          { systemCode: 'state_assigned_id', value: 'example-001', issuingStateCode: null },
        ],
        proposedCandidates: 0,
      }),
    ]);
    expect(await h.websites.missingWebsiteQueue({ stateCodes: ['TX'] })).toEqual([]);
    expect(await h.websites.missingWebsiteQueue({ afterId: h.organizationId })).toEqual([]);
  });

  it('retains a candidate separately until a person verifies it', async () => {
    const h = await harness();
    const candidate = await h.websites.recordCandidate({
      organizationId: h.organizationId,
      url: 'www.examplecity.gov/',
      resolutionMethod: 'official_registry_match',
      matchSignals: { name: 'exact', state: 'exact', officialRegistry: true },
      confidence: 0.94,
      sourceDocumentId: h.sourceDocumentId,
      sourceDocumentVersionId: h.sourceDocumentVersionId,
      observedAt: AT,
    });

    expect(candidate.url).toBe('https://www.examplecity.gov/');
    const before = await h.database.query<{ website_url: string | null }>(
      'select website_url from organizations where id = $1',
      [h.organizationId],
    );
    expect(before.rows[0]?.website_url).toBeNull();
    expect((await h.websites.missingWebsiteQueue())[0]).toMatchObject({
      proposedCandidates: 1,
      bestCandidateConfidence: 0.94,
    });

    const verified = await h.websites.verifyCandidate({
      candidateId: candidate.id,
      reviewedBy: 'owner@example.test',
      reviewNote: 'Matched the official registry and published address.',
      reviewedAt: AT,
    });
    expect(verified.status).toBe('verified');
    expect(await h.websites.missingWebsiteQueue()).toEqual([]);
    const after = await h.database.query<{ website_url: string; primary_domain: string }>(
      'select website_url, primary_domain from organizations where id = $1',
      [h.organizationId],
    );
    expect(after.rows[0]).toEqual({
      website_url: 'https://www.examplecity.gov/',
      primary_domain: 'examplecity.gov',
    });
  });

  it('requires matching document and version provenance', async () => {
    const h = await harness();
    const ingestion = new IngestionRepository(h.database);
    const other = await ingestion.recordSourceDocument({
      url: 'https://other.example.gov/list.json',
      urlCanonical: 'https://other.example.gov/list.json',
      urlHash: 'other-source',
      domain: 'other.example.gov',
      sourceTypeCode: 'api',
      httpStatus: 200,
      contentHash: 'other-content',
      contentType: 'application/json',
      storageKey: null,
      robotsAllowed: null,
      robotsPolicyNote: null,
      crawlRunId: null,
      retrievedAt: AT,
    });

    await expect(
      h.websites.recordCandidate({
        organizationId: h.organizationId,
        url: 'https://example.gov',
        resolutionMethod: 'search_result',
        matchSignals: {},
        confidence: 0.5,
        sourceDocumentId: h.sourceDocumentId,
        sourceDocumentVersionId: other.versionId,
        observedAt: AT,
      }),
    ).rejects.toThrow();
  });
});
