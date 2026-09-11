#!/usr/bin/env node
import { isAllowedDomain, isExcludedUrl } from '@public-workforce/core';
import { existsSync } from 'node:fs';
import {
  CollectionProjectRepository,
  PostgresClient,
  loadSourcePolicyRegistry,
  type ClaimedCollectionJob,
} from '@public-workforce/database';
import { HttpRobotsProvider } from '@public-workforce/core';
import { createLogger } from '@public-workforce/observability';
import { DiscoveryWorker, type DiscoveryState } from '@public-workforce/discovery-worker';
import { CollectionWorker, ProductionCollectionExecutor } from '../collection-worker.js';
import { parseBrowserRenderDomains, shouldRenderWithBrowser } from '../browser-rendering.js';
import { ArchivingFetcher, S3ResponseArchive } from '../fetchers/archiving-fetcher.js';
import { SerialFetcher } from '../fetchers/serial-fetcher.js';
import { BrowserFetcher } from '../fetchers/browser-fetcher.js';
import { HttpFetcher } from '../fetchers/http-fetcher.js';
import {
  buildAdapterRegistry,
  buildCrawlPolicy,
  buildScopedRules,
  buildTaxonomy,
} from '../registries.js';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const databaseUrl = requiredEnvironment('DATABASE_URL');
  const userAgent = requiredEnvironment('CRAWLER_USER_AGENT');
  const contactUrl = requiredEnvironment('CRAWLER_CONTACT_URL');
  const browserRenderDomains = parseBrowserRenderDomains(
    process.env['CRAWLER_RENDER_BROWSER_DOMAINS'],
  );
  const browserFetcherLimits = {
    maxSubresourceRequests: positiveInteger(
      process.env['CRAWLER_RENDER_BROWSER_MAX_SUBRESOURCES'] ?? '50',
      'CRAWLER_RENDER_BROWSER_MAX_SUBRESOURCES',
      250,
    ),
    renderDeadlineMs: positiveInteger(
      process.env['CRAWLER_RENDER_BROWSER_DEADLINE_MS'] ?? '20000',
      'CRAWLER_RENDER_BROWSER_DEADLINE_MS',
      60_000,
    ),
  };
  const daemon = process.argv.includes('--daemon');
  const batchId = daemon ? undefined : requiredArgument('--batch-id');
  const untilBatchComplete = process.argv.includes('--until-batch-complete');
  const maxJobs =
    daemon || untilBatchComplete
      ? null
      : positiveInteger(requiredArgument('--max-jobs'), '--max-jobs', 1000);
  const workerId = `collection-worker:${process.pid}`;
  const logger = createLogger({ name: 'collection-worker', base: { workerId, batchId } });
  const database = new PostgresClient({ connectionString: databaseUrl, max: 4 });
  const taxonomy = buildTaxonomy();
  const adapters = buildAdapterRegistry();
  const fetcher = new ArchivingFetcher(
    new HttpFetcher({ userAgent }),
    new S3ResponseArchive({
      endpoint: requiredEnvironment('STORAGE_ENDPOINT'),
      region: requiredEnvironment('STORAGE_REGION'),
      bucket: requiredEnvironment('STORAGE_BUCKET'),
      accessKeyId: requiredEnvironment('STORAGE_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment('STORAGE_SECRET_ACCESS_KEY'),
    }),
  );
  const robots = new HttpRobotsProvider(
    async (url) => {
      try {
        const response = await fetch(url, {
          headers: { 'user-agent': userAgent },
          signal: AbortSignal.timeout(20_000),
          redirect: 'error',
        });
        return { ok: response.ok, status: response.status, body: await response.text() };
      } catch {
        return { ok: false, status: 0, body: '' };
      }
    },
    { unavailablePolicy: 'deny' },
  );
  const basePolicy = buildCrawlPolicy({ userAgent, contactUrl });

  try {
    const queue = new CollectionProjectRepository(database);
    const renderers = new Map<string, BrowserFetcher[]>();
    const rawFetcherForJob = (job: ClaimedCollectionJob, chargePageBudget = true) => {
      let nextRequestAt = 0;
      return new SerialFetcher(
        new ArchivingFetcher(
          new HttpFetcher({
            userAgent,
            beforeRequest: async (url) => {
              await queue.renewLease(job.id, job.claimToken);
              if (
                !isAllowedDomain(url, job.url, {
                  ...basePolicy,
                  ...(job.websiteScope === undefined ? {} : { websiteScope: job.websiteScope }),
                }) ||
                isExcludedUrl(url).excluded
              )
                throw new Error('request is outside the approved source scope');
              const registry = await loadSourcePolicyRegistry(database);
              registry.assertCollectable(url, 'production');
              const decision = await robots.check(url, userAgent);
              if (!decision.allowed) throw new Error(`robots.txt refuses ${url}`);
              await delay(Math.max(0, nextRequestAt - Date.now()));
              if (chargePageBudget) await queue.reserveRequest(job.id, job.claimToken);
              nextRequestAt =
                Date.now() +
                Math.max(basePolicy.requestDelayMs, (decision.crawlDelaySeconds ?? 0) * 1000);
            },
          }),
          new S3ResponseArchive({
            endpoint: requiredEnvironment('STORAGE_ENDPOINT'),
            region: requiredEnvironment('STORAGE_REGION'),
            bucket: requiredEnvironment('STORAGE_BUCKET'),
            accessKeyId: requiredEnvironment('STORAGE_ACCESS_KEY_ID'),
            secretAccessKey: requiredEnvironment('STORAGE_SECRET_ACCESS_KEY'),
          }),
        ),
      );
    };
    const fetcherForJob = (job: ClaimedCollectionJob) => {
      const transport = rawFetcherForJob(job);
      if (!shouldRenderWithBrowser(job.url, browserRenderDomains)) return transport;
      const renderer = new BrowserFetcher(
        transport,
        userAgent,
        rawFetcherForJob(job, false),
        browserFetcherLimits,
      );
      renderers.set(job.id, [...(renderers.get(job.id) ?? []), renderer]);
      return new ArchivingFetcher(
        renderer,
        new S3ResponseArchive({
          endpoint: requiredEnvironment('STORAGE_ENDPOINT'),
          region: requiredEnvironment('STORAGE_REGION'),
          bucket: requiredEnvironment('STORAGE_BUCKET'),
          accessKeyId: requiredEnvironment('STORAGE_ACCESS_KEY_ID'),
          secretAccessKey: requiredEnvironment('STORAGE_SECRET_ACCESS_KEY'),
        }),
      );
    };
    const executor = new ProductionCollectionExecutor({
      client: database,
      fetcher,
      robots,
      adapters,
      taxonomy,
      logger,
      workerId,
      policy: basePolicy,
      fetcherForJob,
      discover: async (job) => {
        const sourcePolicy = await loadSourcePolicyRegistry(database);
        const rules = buildScopedRules(taxonomy, {
          governmentLevelCode: job.governmentLevelCode,
          sectorCode: job.sectorCode,
        });
        const discovery = new DiscoveryWorker({
          client: database,
          fetcher: fetcherForJob(job),
          robots,
          adapters,
          logger,
          vocabulary: rules.vocabulary,
          policy: {
            ...basePolicy,
            ...(job.websiteScope === undefined ? {} : { websiteScope: job.websiteScope }),
            maxPagesPerRun: job.maxPagesPerTarget,
            maxDepth: 3,
          },
          collectionMode: 'production',
          sourcePolicy,
          ...(job.discoveryState == null
            ? {}
            : { resumeFrom: job.discoveryState as DiscoveryState }),
          onCheckpoint: (state) => queue.saveDiscoveryState(job.id, job.claimToken, state),
          assertActive: () => queue.renewLease(job.id, job.claimToken),
        });
        const result = await discovery.discover({
          organizationId: job.organizationId,
          jurisdictionId: job.jurisdictionId,
          siteUrl: job.url,
          organizationName: job.organizationName,
          parentOrganizationName: job.parentOrganizationName,
        });
        return {
          pagesProcessed: result.pagesProcessed,
          targetsRecorded: result.targetsRecorded,
          outcome: result.outcome,
          detail: result.note,
          retryable: result.retryable,
        };
      },
    });
    const worker = new CollectionWorker({
      queue,
      executor: {
        execute: async (job) => {
          try {
            return await executor.execute(job);
          } finally {
            const closing = renderers.get(job.id) ?? [];
            renderers.delete(job.id);
            await Promise.all(closing.map((renderer) => renderer.close()));
          }
        },
      },
      workerId,
      logger,
      batchId,
    });
    if (daemon) {
      const pollMilliseconds = positiveInteger(
        process.env['WORKER_POLL_INTERVAL_MS'] ?? '5000',
        'WORKER_POLL_INTERVAL_MS',
        60_000,
      );
      let stopping = false;
      const stop = (): void => {
        stopping = true;
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      logger.info({ pollMilliseconds }, 'approved collection worker daemon ready');
      const concurrency = positiveInteger(
        process.env['WORKER_CONCURRENCY'] ?? '4',
        'WORKER_CONCURRENCY',
        10,
      );
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (!stopping) {
            const outcome = await worker.runNext();
            if (outcome === 'empty') await delay(pollMilliseconds);
          }
        }),
      );
      logger.info('approved collection worker daemon stopped');
      return;
    }
    const result = untilBatchComplete
      ? await worker.drainApprovedBatch()
      : await worker.drain(maxJobs ?? 1);
    logger.info(
      { ...result, maxJobs, untilBatchComplete },
      'approved collection batch worker stopped',
    );
  } finally {
    await database.close();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required for production collection`);
  }
  return value;
}

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(
      `${name} is required; a worker must name one approved batch and a finite job limit`,
    );
  }
  return value;
}

function positiveInteger(raw: string, name: string, maximum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a whole number between 1 and ${maximum}`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
