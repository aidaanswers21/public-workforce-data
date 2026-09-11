import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '@public-workforce/observability';
import {
  CollectionProjectRepository,
  IngestionRepository,
  OrganizationRepository,
  SourcePolicyRepository,
  TestDatabase,
  type ClaimedCollectionJob,
} from '@public-workforce/database';
import { educationSectorPack } from '@public-workforce/sector-education';
import { contentHash, PermissiveRobotsProvider } from '@public-workforce/core';
import type { Fetcher } from '@public-workforce/shared-types';
import { buildAdapterRegistry, buildTaxonomy } from './registries.js';
import { CollectionWorker, ProductionCollectionExecutor } from './collection-worker.js';

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.close();
  database = null;
});

const job: ClaimedCollectionJob = {
  id: 'job-id',
  projectId: 'project-id',
  batchId: 'batch-id',
  kind: 'crawl',
  claimToken: 'claim-token',
  crawlTargetId: 'target-id',
  url: 'https://example.gov/directory',
  adapterKey: 'generic-html',
  sourceTypeCode: 'html_directory',
  organizationId: 'organization-id',
  organizationName: 'Example Agency',
  parentOrganizationName: null,
  jurisdictionId: null,
  governmentLevelCode: 'state',
  sectorCode: 'general_government',
  maxPagesPerTarget: 5,
  crawlRunId: null,
};

describe('collection worker', () => {
  it('executes and completes one leased approved job', async () => {
    const queue = {
      batchHasPendingWork: vi.fn().mockResolvedValue(false),
      claimNextJob: vi.fn().mockResolvedValue(job),
      markJobRunning: vi.fn().mockResolvedValue(undefined),
      completeJob: vi.fn().mockResolvedValue(undefined),
      failJob: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new CollectionWorker({
      queue: queue as unknown as CollectionProjectRepository,
      executor: {
        execute: vi.fn().mockResolvedValue({
          crawlRunId: 'run-id',
          pagesProcessed: 2,
          recordsCollected: 12,
          outcome: 'completed',
          detail: null,
        }),
      },
      workerId: 'worker-one',
      logger: createSilentLogger(),
    });

    expect(await worker.runNext()).toBe('completed');
    expect(queue.markJobRunning).toHaveBeenCalledWith('job-id', 'claim-token', null);
    expect(queue.completeJob).toHaveBeenCalledWith({
      jobId: 'job-id',
      claimToken: 'claim-token',
      crawlRunId: 'run-id',
      pagesProcessed: 2,
      recordsCollected: 12,
    });
  });

  it('records a failure and never exceeds the local drain ceiling', async () => {
    const queue = {
      batchHasPendingWork: vi.fn().mockResolvedValue(false),
      claimNextJob: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
      markJobRunning: vi.fn().mockResolvedValue(undefined),
      completeJob: vi.fn().mockResolvedValue(undefined),
      failJob: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new CollectionWorker({
      queue: queue as unknown as CollectionProjectRepository,
      executor: { execute: vi.fn().mockRejectedValue(new Error('adapter failed')) },
      workerId: 'worker-one',
      logger: createSilentLogger(),
    });

    expect(await worker.drain(2)).toEqual({ completed: 0, failed: 1, held: 0 });
    expect(queue.claimNextJob).toHaveBeenCalledTimes(2);
    expect(queue.failJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-id', retryable: false }),
    );
  });

  it('requeues a checkpoint continuation without completing the job', async () => {
    const queue = {
      batchHasPendingWork: vi.fn().mockResolvedValue(true),
      claimNextJob: vi.fn().mockResolvedValue(job),
      markJobRunning: vi.fn().mockResolvedValue(undefined),
      continueJob: vi.fn().mockResolvedValue(undefined),
      completeJob: vi.fn().mockResolvedValue(undefined),
      failJob: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new CollectionWorker({
      queue: queue as unknown as CollectionProjectRepository,
      executor: {
        execute: vi.fn().mockResolvedValue({
          crawlRunId: 'run-id',
          pagesProcessed: 250,
          recordsCollected: 500,
          outcome: 'continuation',
          retryable: true,
          detail: 'partial collection: run budget of 250 pages reached',
        }),
      },
      workerId: 'worker-one',
      logger: createSilentLogger(),
    });

    expect(await worker.runNext()).toBe('continued');
    expect(queue.continueJob).toHaveBeenCalledWith({
      jobId: 'job-id',
      claimToken: 'claim-token',
      crawlRunId: 'run-id',
      pagesProcessed: 250,
      recordsCollected: 500,
      detail: 'partial collection: run budget of 250 pages reached',
    });
    expect(queue.completeJob).not.toHaveBeenCalled();
    expect(queue.failJob).not.toHaveBeenCalled();
  });

  it('continues until one approved batch queue is empty', async () => {
    const secondJob = { ...job, id: 'job-two', claimToken: 'claim-two' };
    const queue = {
      batchHasPendingWork: vi.fn().mockResolvedValue(false),
      claimNextJob: vi
        .fn()
        .mockResolvedValueOnce(job)
        .mockResolvedValueOnce(secondJob)
        .mockResolvedValue(null),
      markJobRunning: vi.fn().mockResolvedValue(undefined),
      completeJob: vi.fn().mockResolvedValue(undefined),
      failJob: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new CollectionWorker({
      queue: queue as unknown as CollectionProjectRepository,
      executor: {
        execute: vi.fn().mockResolvedValue({
          crawlRunId: null,
          pagesProcessed: 1,
          recordsCollected: 4,
          outcome: 'completed',
          detail: null,
        }),
      },
      workerId: 'worker-one',
      batchId: 'batch-id',
      logger: createSilentLogger(),
    });

    expect(await worker.drainApprovedBatch()).toEqual({ completed: 2, failed: 0, held: 0 });
    expect(queue.claimNextJob).toHaveBeenCalledTimes(3);
  });

  it('refuses an unscoped continue-until-empty worker', async () => {
    const worker = new CollectionWorker({
      queue: {} as CollectionProjectRepository,
      executor: { execute: vi.fn() },
      workerId: 'worker-one',
      logger: createSilentLogger(),
    });

    await expect(worker.drainApprovedBatch()).rejects.toThrow(/approved batch id/);
  });

  it('persists and resumes a directory beyond 250 pages before completing it', async () => {
    database = await TestDatabase.create({ sectors: [educationSectorPack] });
    const ingestion = new IngestionRepository(database);
    const organizations = new OrganizationRepository(database);
    const source = await ingestion.recordSourceDocument({
      url: 'https://directory.example.test/',
      urlCanonical: 'https://directory.example.test/',
      urlHash: 'large-directory-bootstrap',
      domain: 'directory.example.test',
      sourceTypeCode: 'html_directory',
      httpStatus: 200,
      contentHash: 'large-directory-bootstrap',
      contentType: 'text/html',
      storageKey: null,
      robotsAllowed: true,
      robotsPolicyNote: null,
      crawlRunId: null,
      retrievedAt: '2026-09-11T00:00:00.000Z',
    });
    const primary = await organizations.upsertOrganization({
      organizationTypeCode: 'school',
      governmentLevelCode: 'special_district',
      sectorCode: 'education',
      name: 'Fixture School',
      nameNormalized: 'fixture school',
      websiteUrl: 'https://directory.example.test/',
      sourceDocumentId: source.documentId,
      extractionMethod: 'bulk_import',
      confidence: 1,
      observedAt: '2026-09-11T00:00:00.000Z',
      identifier: { systemCode: 'nces_school_id', value: '480000000001' },
    });
    const other = await organizations.upsertOrganization({
      organizationTypeCode: 'school',
      governmentLevelCode: 'special_district',
      sectorCode: 'education',
      name: 'Other Fixture School',
      nameNormalized: 'other fixture school',
      websiteUrl: null,
      sourceDocumentId: source.documentId,
      extractionMethod: 'bulk_import',
      confidence: 1,
      observedAt: '2026-09-11T00:00:00.000Z',
      identifier: { systemCode: 'nces_school_id', value: '480000000002' },
    });
    await database.query(
      `insert into organization_locations(organization_id,state_code,is_primary,source_document_id,extraction_method_code,confidence)
         values ($1,'TX',true,$3,'bulk_import',1),($2,'TX',true,$3,'bulk_import',1)`,
      [primary.id, other.id, source.documentId],
    );
    const queue = new CollectionProjectRepository(database);
    const projectId = await queue.create({
      key: `large-directory-${crypto.randomUUID()}`,
      name: 'Large directory fixture',
      jurisdictionConfigKey: 'fixture-education',
      jurisdictionCode: 'fixture-education',
      stateCode: 'TX',
      sectorCodes: ['education'],
      governmentLevelCodes: ['special_district'],
      batchSize: 1,
      maxPagesPerTarget: 300,
      maxPagesPerBatch: 500,
      maxErrorsPerBatch: 10,
      createdBy: 'owner',
    });
    const target = await database.query<{ id: string }>(
      `insert into crawl_targets(organization_id,url,url_hash,target_type,source_type_code,adapter_key,status)
         values ($1,$2,$3,'unit_directory','html_directory','generic-html','ready') returning id`,
      [primary.id, 'https://directory.example.test/staff?page=1', 'large-directory-target'],
    );
    const targetId = target.rows[0]!.id;
    await database.query(
      `insert into crawl_target_organizations(crawl_target_id,organization_id,source_document_id)
         values ($1,$2,$4),($1,$3,$4)`,
      [targetId, primary.id, other.id, source.documentId],
    );
    await new SourcePolicyRepository(database).recordReview({
      domain: 'example.test',
      collectionStatus: 'permitted',
      commercialUseStatus: 'unknown',
      automatedAccessStatus: 'permitted',
      solicitationStatus: 'unknown',
      reviewNotes: 'Saved multi-page fixture only',
      reviewedBy: 'owner',
    });
    const batchId = await queue.createApprovedBatch({
      projectId,
      kind: 'crawl',
      targetLimit: 1,
      approvedBy: 'owner',
      approvalNote: 'Approve the saved 260-page fixture target.',
    });

    const requested: string[] = [];
    const fetcher: Fetcher = {
      key: 'large-directory-fixture',
      fetch: (request) => {
        requested.push(request.url);
        const page = Number(new URL(request.url).searchParams.get('page'));
        if (!Number.isInteger(page) || page < 1 || page > 260) {
          return Promise.resolve({
            ok: false,
            failure: {
              url: request.url,
              errorType: 'http_error',
              message: 'fixture page absent',
              status: 404,
              retryable: false,
            },
          });
        }
        const organization = page === 125 ? '<td>Ambiguous School</td>' : '<td>Fixture School</td>';
        const title = 'Teacher';
        const organizationHeader = '<th>School</th>';
        const next = page === 260 ? '' : `<a href="/staff?page=${page + 1}" rel="next">Next</a>`;
        const body = `<html><body><table><tr><th>Name</th><th>Title</th>${organizationHeader}<th>Email</th></tr><tr><td>Person ${page}</td><td>${title}</td>${organization}<td><a href="mailto:person${page}@directory.example.test">person${page}@directory.example.test</a></td></tr></table>${next}</body></html>`;
        return Promise.resolve({
          ok: true,
          page: {
            url: request.url,
            finalUrl: request.url,
            status: 200,
            headers: {},
            body,
            contentType: 'text/html',
            contentHash: contentHash(body),
            fetchedAt: '2026-09-11T00:00:00.000Z',
            fromCache: true,
            storageKey: `fixture:large-directory:${page}`,
          },
        });
      },
    };
    const logger = createSilentLogger();
    const executor = new ProductionCollectionExecutor({
      client: database,
      fetcher,
      robots: new PermissiveRobotsProvider(),
      adapters: buildAdapterRegistry(),
      taxonomy: buildTaxonomy(),
      logger,
      workerId: 'fixture-worker',
      sleep: () => Promise.resolve(),
      policy: { requestDelayMs: 0 },
      discover: () => {
        throw new Error('discovery is not part of this fixture');
      },
    });
    const worker = new CollectionWorker({
      queue,
      executor,
      workerId: 'fixture-worker',
      logger,
      batchId,
    });

    expect(await worker.runNext()).toBe('continued');
    const afterFirst = await database.query<Record<string, unknown>>(
      'select status,crawl_run_id,pages_processed,records_collected from collection_jobs where batch_id=$1',
      [batchId],
    );
    expect(afterFirst.rows[0]).toMatchObject({
      status: 'queued',
      pages_processed: 250,
      records_collected: 249,
    });
    const crawlRunId = String(afterFirst.rows[0]?.['crawl_run_id']);
    expect(crawlRunId).not.toBe('null');
    expect(await database.count('people')).toBe(249);
    expect(await database.count('crawl_pages')).toBe(250);
    // The engine boundary removes prohibited raw values before this integration
    // fixture can safely persist them. Seed the durable aggregate directly to
    // prove the next executor slice carries an earlier boundary drop forward.
    await database.query(
      `update crawl_checkpoints
       set payload=jsonb_set(payload,'{ingestionSummary,boundaryDrops}','1'::jsonb)
       where crawl_run_id=$1`,
      [crawlRunId],
    );

    expect(await worker.runNext()).toBe('completed');
    const completed = await database.query<Record<string, unknown>>(
      'select status,crawl_run_id,pages_processed,records_collected,outcome_detail from collection_jobs where batch_id=$1',
      [batchId],
    );
    expect(completed.rows[0]).toMatchObject({
      status: 'completed',
      crawl_run_id: crawlRunId,
      pages_processed: 260,
      records_collected: 259,
    });
    expect(String(completed.rows[0]?.['outcome_detail'])).toContain('2 ingestion errors');
    expect(String(completed.rows[0]?.['outcome_detail'])).toContain('1 boundary drop');
    expect(await database.count('people')).toBe(259);
    expect(await database.count('crawl_pages')).toBe(261);
    expect(new Set(requested).size).toBe(261);
    expect(requested).toHaveLength(261);
    const run = await database.query<{ status: string }>(
      'select status from crawl_runs where id=$1',
      [crawlRunId],
    );
    expect(run.rows[0]?.status).toBe('completed_with_errors');
    expect((await queue.listBatches(projectId))[0]).toMatchObject({
      status: 'completed_with_errors',
      completedJobs: 1,
      queuedJobs: 0,
    });
  }, 120_000);
});
