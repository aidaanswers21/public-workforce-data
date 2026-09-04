#!/usr/bin/env node
import { existsSync } from 'node:fs';
import {
  CollectionProjectRepository,
  PostgresClient,
  loadSourcePolicyRegistry,
} from '@public-workforce/database';
import { HttpRobotsProvider } from '@public-workforce/core';
import { createLogger } from '@public-workforce/observability';
import { DiscoveryWorker } from '@public-workforce/discovery-worker';
import { CollectionWorker, ProductionCollectionExecutor } from '../collection-worker.js';
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
  const fetcher = new HttpFetcher({ userAgent });
  const robots = new HttpRobotsProvider(
    async (url) => {
      try {
        const response = await fetch(url, {
          headers: { 'user-agent': userAgent },
          signal: AbortSignal.timeout(20_000),
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
    const executor = new ProductionCollectionExecutor({
      client: database,
      fetcher,
      robots,
      adapters,
      taxonomy,
      logger,
      workerId,
      discover: async (job) => {
        const sourcePolicy = await loadSourcePolicyRegistry(database);
        const policyDecision = sourcePolicy.evaluate(job.url, 'production');
        const rules = buildScopedRules(taxonomy, {
          governmentLevelCode: job.governmentLevelCode,
          sectorCode: job.sectorCode,
        });
        const discovery = new DiscoveryWorker({
          client: database,
          fetcher,
          robots,
          adapters,
          logger,
          vocabulary: rules.vocabulary,
          policy: {
            ...basePolicy,
            maxPagesPerRun: Math.min(5, job.maxPagesPerTarget),
            maxDepth: 1,
          },
          collectionMode: 'production',
          sourcePolicy,
        });
        const result = await discovery.discover({
          organizationId: job.organizationId,
          jurisdictionId: job.jurisdictionId,
          siteUrl: job.url,
          organizationName: job.organizationName,
          parentOrganizationName: job.parentOrganizationName,
        });
        return {
          pagesProcessed: result.blocked ? 0 : 1,
          targetsRecorded: result.targetsRecorded,
          outcome: result.blocked
            ? policyDecision.allowed
              ? ('blocked' as const)
              : ('policy_hold' as const)
            : ('completed' as const),
          detail: result.note,
        };
      },
    });
    const worker = new CollectionWorker({
      queue,
      executor,
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
      while (!stopping) {
        const outcome = await worker.runNext();
        if (outcome === 'empty') await delay(pollMilliseconds);
      }
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
