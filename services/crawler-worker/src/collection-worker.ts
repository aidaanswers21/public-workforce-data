import type { Logger } from '@public-workforce/observability';
import {
  CrawlRepository,
  CollectionProjectRepository,
  IngestionRepository,
  OrganizationRepository,
  loadSourcePolicyRegistry,
  type ClaimedCollectionJob,
  type SqlClient,
} from '@public-workforce/database';
import { CrawlEngine, type CrawlPolicy } from '@public-workforce/core';
import type { Fetcher, RobotsProvider } from '@public-workforce/shared-types';
import type { AdapterRegistry } from '@public-workforce/adapter-kit';
import type { Taxonomy } from '@public-workforce/taxonomy';
import { IngestionPipeline } from './pipeline.js';
import { buildCrawlPolicy, buildScopedRules } from './registries.js';

export interface CollectionJobResult {
  crawlRunId: string | null;
  pagesProcessed: number;
  recordsCollected: number;
  outcome: 'completed' | 'policy_hold' | 'blocked' | 'failed';
  retryable?: boolean;
  detail: string | null;
}

export interface CollectionJobExecutor {
  /**
   * Executes the already claimed target through the normal discovery or crawl
   * engine. The queue has checked batch approval and source policy first; the
   * engine remains responsible for checking source policy and robots before
   * each request.
   */
  execute(job: ClaimedCollectionJob): Promise<CollectionJobResult>;
}

export interface ScheduledDiscoveryResult {
  pagesProcessed: number;
  targetsRecorded: number;
  outcome: 'completed' | 'policy_hold' | 'blocked' | 'failed';
  retryable?: boolean;
  detail: string | null;
}

export interface ProductionCollectionExecutorOptions {
  client: SqlClient;
  fetcher: Fetcher;
  robots: RobotsProvider;
  adapters: AdapterRegistry;
  taxonomy: Taxonomy;
  logger: Logger;
  workerId: string;
  /** The discovery service is injected so it can remain independently deployable. */
  discover(job: ClaimedCollectionJob): Promise<ScheduledDiscoveryResult>;
  sleep?: (milliseconds: number) => Promise<void>;
  policy?: Partial<CrawlPolicy>;
  fetcherForJob?: (job: ClaimedCollectionJob) => Fetcher;
}

/** Runs a claimed job through the existing discovery or ingestion pipeline. */
export class ProductionCollectionExecutor implements CollectionJobExecutor {
  constructor(private readonly options: ProductionCollectionExecutorOptions) {}

  async execute(job: ClaimedCollectionJob): Promise<CollectionJobResult> {
    if (job.kind === 'discovery') {
      const result = await this.options.discover(job);
      return {
        crawlRunId: null,
        pagesProcessed: result.pagesProcessed,
        recordsCollected: 0,
        outcome: result.outcome,
        detail: result.detail,
        retryable: result.retryable ?? false,
      };
    }

    const adapter = job.adapterKey === null ? null : this.options.adapters.get(job.adapterKey);
    if (adapter === null) throw new Error(`no registered adapter is recorded for ${job.url}`);

    const crawl = new CrawlRepository(this.options.client);
    const associations = await this.options.client.query<{
      id: string;
      name: string;
      government_level_code: string | null;
      sector_code: string;
      jurisdiction_id: string | null;
    }>(
      `select o.id,o.name,o.government_level_code,o.sector_code,o.jurisdiction_id from crawl_target_organizations link
       join organizations o on o.id=link.organization_id
       where link.crawl_target_id=$1 and ($3::boolean=false or exists(select 1 from collection_batch_organizations scope where scope.batch_id=$2 and scope.organization_id=o.id))`,
      [job.crawlTargetId, job.batchId, job.collectDiscovered ?? false],
    );
    const pipeline = new IngestionPipeline({
      ingestion: new IngestionRepository(this.options.client),
      crawl,
      organizations: new OrganizationRepository(this.options.client),
      logger: this.options.logger,
      assertActive: () =>
        new CollectionProjectRepository(this.options.client).renewLease(job.id, job.claimToken),
      resolveContext: (record, context) => {
        if (associations.rows.length <= 1) return context;
        const published = record.record.organizationPublished?.trim().toLowerCase();
        const matched = associations.rows.filter(
          (org) => org.name.trim().toLowerCase() === published,
        );
        const organization = matched.length === 1 ? matched[0] : undefined;
        if (organization === undefined) return null;
        const rules = buildScopedRules(this.options.taxonomy, {
          governmentLevelCode: organization.government_level_code,
          sectorCode: organization.sector_code,
        });
        return {
          ...context,
          organizationId: organization.id,
          organizationName: organization.name,
          governmentLevelCode: organization.government_level_code,
          sectorCode: organization.sector_code,
          jurisdictionId: organization.jurisdiction_id,
          vocabulary: rules.vocabulary,
          titleRules: rules.titleRules,
        };
      },
    });
    const rules = buildScopedRules(this.options.taxonomy, {
      governmentLevelCode: job.governmentLevelCode,
      sectorCode: job.sectorCode,
    });
    let crawlRunId = job.crawlRunId;
    if (crawlRunId === null) {
      crawlRunId = await crawl.startRun({
        jurisdictionId: job.jurisdictionId,
        runType: 'scheduled_collection',
        config: {
          projectId: job.projectId,
          batchId: job.batchId,
          crawlTargetId: job.crawlTargetId,
          maxPagesPerTarget: job.maxPagesPerTarget,
        },
        initiatedBy: this.options.workerId,
      });
      const queue = new CollectionProjectRepository(this.options.client);
      await queue.attachCrawlRun(job.id, job.claimToken, crawlRunId);
    }

    const resumeFrom = await crawl.loadCheckpoint(crawlRunId, job.crawlTargetId);
    const sourcePolicy = await loadSourcePolicyRegistry(this.options.client);
    const engine = new CrawlEngine({
      fetcher: this.options.fetcherForJob?.(job) ?? this.options.fetcher,
      robots: this.options.robots,
      logger: this.options.logger,
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      onCheckpoint: (checkpoint) => crawl.saveCheckpoint(checkpoint),
    });

    try {
      const result = await engine.run({
        crawlRunId,
        crawlTargetId: job.crawlTargetId,
        seedUrl: job.url,
        adapter,
        policy: buildCrawlPolicy({
          ...this.options.policy,
          ...(job.websiteScope === undefined ? {} : { websiteScope: job.websiteScope }),
          maxPagesPerRun: job.maxPagesPerTarget,
        }),
        vocabulary: rules.vocabulary,
        organizationName: job.organizationName,
        parentOrganizationName: job.parentOrganizationName,
        collectionMode: 'production',
        sourcePolicy,
        ...(resumeFrom === null ? {} : { resumeFrom }),
      });
      await new CollectionProjectRepository(this.options.client).renewLease(job.id, job.claimToken);
      const summary = await pipeline.ingestRun(result, {
        organizationId: job.organizationId,
        organizationName: job.organizationName,
        governmentLevelCode: job.governmentLevelCode,
        sectorCode: job.sectorCode,
        jurisdictionId: job.jurisdictionId,
        sourceTypeCode: job.sourceTypeCode,
        vocabulary: rules.vocabulary,
        titleRules: rules.titleRules,
      });
      const outcome = crawlOutcome(result.stops.map((stop) => stop.reason));
      const partial =
        result.checkpoint.pendingTasks.length > 0 || result.errors.length > 0 || summary.errors > 0;
      await crawl.finishRun(
        crawlRunId,
        outcome === 'completed'
          ? result.errors.length > 0
            ? 'completed_with_errors'
            : 'completed'
          : 'cancelled',
        result.stats,
        new Date().toISOString(),
      );
      return {
        crawlRunId,
        pagesProcessed: result.stats.pagesFetched,
        recordsCollected: summary.peopleSeen,
        outcome,
        detail: partial
          ? `partial collection: ${result.stops.at(-1)?.detail ?? 'errors or unfinished pages'}`
          : result.records.length === 0
            ? 'no public contacts extracted'
            : null,
      };
    } catch (error) {
      await crawl.finishRun(
        crawlRunId,
        'failed',
        {
          pagesFetched: resumeFrom?.pagesFetched ?? 0,
          pagesSkipped: 0,
          pagesFailed: 1,
          recordsExtracted: 0,
          recordsNew: 0,
          recordsUpdated: 0,
          errors: 1,
          bytesFetched: 0,
          durationMs: 0,
        },
        new Date().toISOString(),
      );
      throw error;
    }
  }
}

export interface CollectionWorkerOptions {
  queue: CollectionProjectRepository;
  executor: CollectionJobExecutor;
  workerId: string;
  logger: Logger;
  leaseSeconds?: number;
  heartbeatMilliseconds?: number;
  sleep?: (ms: number) => Promise<void>;
  /** A production invocation names the exact approved batch it is consuming. */
  batchId?: string;
}

/**
 * Pulls finite, approved work from the durable queue.
 *
 * A caller can set a smaller local job ceiling or drain one named approved
 * batch. Neither mode can cross the batch boundary, keeping project scope,
 * operator approval and process concurrency as separate controls.
 */
export class CollectionWorker {
  constructor(private readonly options: CollectionWorkerOptions) {}

  async runNext(): Promise<'completed' | 'failed' | 'held' | 'empty'> {
    const job = await this.options.queue.claimNextJob(
      this.options.workerId,
      this.options.leaseSeconds,
      this.options.batchId ?? null,
    );
    if (job === null) return 'empty';

    const heartbeat: { failure: Error | null; renewing: Promise<void> | null } = {
      failure: null,
      renewing: null,
    };
    const timer = setInterval(() => {
      if (heartbeat.renewing !== null) return;
      heartbeat.renewing = this.options.queue
        .renewLease(job.id, job.claimToken, this.options.leaseSeconds)
        .catch((error: unknown) => {
          heartbeat.failure = error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => {
          heartbeat.renewing = null;
        });
    }, this.options.heartbeatMilliseconds ?? 30000);
    timer.unref();
    try {
      await this.options.queue.markJobRunning(job.id, job.claimToken, job.crawlRunId);
      const result = await this.options.executor.execute(job);
      if (heartbeat.failure !== null) throw heartbeat.failure;
      if (result.outcome === 'failed') {
        await this.options.queue.failJob({
          jobId: job.id,
          claimToken: job.claimToken,
          error: result.detail ?? 'collection failed',
          retryable: result.retryable ?? false,
        });
        return 'failed';
      }
      if (result.outcome !== 'completed') {
        await this.options.queue.blockJob({
          jobId: job.id,
          claimToken: job.claimToken,
          outcome: result.outcome,
          reason: result.detail ?? 'collection engine refused the target',
        });
        return 'held';
      }
      await this.options.queue.completeJob({
        jobId: job.id,
        claimToken: job.claimToken,
        crawlRunId: result.crawlRunId,
        pagesProcessed: result.pagesProcessed,
        recordsCollected: result.recordsCollected,
        ...(result.detail === null ? {} : { detail: result.detail }),
      });
      this.options.logger.info(
        { jobId: job.id, batchId: job.batchId, kind: job.kind },
        'approved collection job completed',
      );
      return 'completed';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        error instanceof Error &&
        ['AbortError', 'TimeoutError', 'NetworkError'].includes(error.name);
      await this.options.queue
        .failJob({
          jobId: job.id,
          claimToken: job.claimToken,
          error: message,
          retryable,
        })
        .catch((claimError: unknown) => {
          this.options.logger.warn(
            { jobId: job.id, error: String(claimError) },
            'failed worker no longer owns the claim',
          );
        });
      this.options.logger.error(
        { jobId: job.id, batchId: job.batchId, kind: job.kind, message },
        'approved collection job failed',
      );
      return 'failed';
    } finally {
      clearInterval(timer);
      if (heartbeat.renewing !== null) await heartbeat.renewing;
    }
  }

  async drain(maxJobs: number): Promise<{ completed: number; failed: number; held: number }> {
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 1000) {
      throw new Error('worker job limit must be between 1 and 1000');
    }
    let completed = 0;
    let failed = 0;
    let held = 0;
    for (let attempted = 0; attempted < maxJobs; attempted += 1) {
      const result = await this.runNext();
      if (result === 'empty') break;
      if (result === 'completed') completed += 1;
      else if (result === 'failed') failed += 1;
      else held += 1;
    }
    return { completed, failed, held };
  }

  /**
   * Drains one specifically approved batch until its finite queue is empty.
   *
   * This removes an arbitrary process-level stop, not the batch boundary. The
   * database still enforces the approved target set, page and error circuit
   * breakers, retry count, source policy and one-active-job-per-domain guard.
   */
  async drainApprovedBatch(): Promise<{ completed: number; failed: number; held: number }> {
    if (this.options.batchId === undefined) {
      throw new Error('draining to completion requires one approved batch id');
    }
    let completed = 0;
    let failed = 0;
    let held = 0;
    for (;;) {
      const result = await this.runNext();
      if (result === 'empty') {
        if (await this.options.queue.batchHasPendingWork(this.options.batchId)) {
          await (
            this.options.sleep ??
            ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
          )(1000);
          continue;
        }
        return { completed, failed, held };
      }
      if (result === 'completed') completed += 1;
      else if (result === 'failed') failed += 1;
      else held += 1;
    }
  }
}

function crawlOutcome(reasons: readonly string[]): 'completed' | 'policy_hold' | 'blocked' {
  if (reasons.includes('blocked_by_source_policy')) return 'policy_hold';
  if (reasons.some((reason) => ['blocked_by_robots', 'blocked_by_source'].includes(reason))) {
    return 'blocked';
  }
  return 'completed';
}
