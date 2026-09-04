import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '@public-workforce/observability';
import type { ClaimedCollectionJob, CollectionProjectRepository } from '@public-workforce/database';
import { CollectionWorker } from './collection-worker.js';

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

  it('continues until one approved batch queue is empty', async () => {
    const secondJob = { ...job, id: 'job-two', claimToken: 'claim-two' };
    const queue = {
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
});
