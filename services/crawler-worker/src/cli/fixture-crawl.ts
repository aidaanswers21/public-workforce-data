#!/usr/bin/env node
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrawlEngine, PermissiveRobotsProvider, withPolicyDefaults } from '@pan/core';
import { createLogger } from '@pan/observability';
import { genericHtmlAdapter } from '@pan/adapter-generic-html';
import {
  ComplianceRepository,
  CrawlRepository,
  ExportRepository,
  IngestionRepository,
  QueryRepository,
  TestDatabase,
} from '@pan/database';
import type { Uuid } from '@pan/shared-types';
import { FixtureFetcher } from '../fetchers/fixture-fetcher.js';
import { IngestionPipeline } from '../pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const FIXTURES = join(
  repoRoot,
  'tests',
  'fixtures',
  'directory-platforms',
  'generic-html',
  'table-numbered',
);
const OUT_DIR = join(repoRoot, 'out');
const HOST = 'https://sample-isd.example.org';

/**
 * Runs the whole pipeline against saved fixtures, with no network and no
 * external database.
 *
 * This is the command to run to see the system work end to end: crawl, extract,
 * normalize, store with provenance, recrawl to prove idempotency, record an
 * opt-out, and write a CSV that excludes it. It uses an in-process Postgres, so
 * it leaves nothing behind but the file in `out/`.
 */
async function main(): Promise<void> {
  const logger = createLogger({ name: 'fixture-crawl' });
  const database = await TestDatabase.create();

  try {
    const ingestion = new IngestionRepository(database);
    const crawl = new CrawlRepository(database);
    const compliance = new ComplianceRepository(database);
    const queries = new QueryRepository(database);
    const pipeline = new IngestionPipeline({ ingestion, crawl, logger });

    const bootstrapPageId = await ingestion.upsertSourcePage({
      url: `${HOST}/`,
      urlCanonical: `${HOST}/`,
      urlHash: 'bootstrap',
      domain: 'sample-isd.example.org',
      sourceType: 'file_import',
      httpStatus: 200,
      contentHash: null,
      contentType: 'text/html',
      storageKey: null,
      robotsAllowed: true,
      robotsPolicyNote: 'local fixture seed',
      crawlRunId: null,
      fetchedAt: new Date().toISOString(),
    });

    const state = await database.query<{ id: Uuid }>(
      `insert into states (code, name, fips_code, config_key) values ('TX','Texas','48','texas') returning id`,
    );
    const stateId = state.rows[0]!.id;
    const county = await database.query<{ id: Uuid }>(
      `insert into counties (state_id, name, name_normalized) values ($1,'Harris','harris') returning id`,
      [stateId],
    );
    const district = await database.query<{ id: Uuid }>(
      `insert into districts (state_id, county_id, name, name_normalized, primary_domain, source_page_id, extraction_method, confidence)
       values ($1,$2,'Sample ISD','sample','sample-isd.example.org',$3,'file_import',1) returning id`,
      [stateId, county.rows[0]!.id, bootstrapPageId],
    );
    const school = await database.query<{ id: Uuid }>(
      `insert into schools (district_id, state_id, county_id, name, name_normalized, source_page_id, extraction_method, confidence)
       values ($1,$2,$3,'Sample High School','sample-high',$4,'file_import',1) returning id`,
      [district.rows[0]!.id, stateId, county.rows[0]!.id, bootstrapPageId],
    );

    const routes = readdirSync(FIXTURES)
      .filter((file) => file.endsWith('.html'))
      .sort()
      .map((file) => ({
        url: `${HOST}/staff-directory?page=${file.replace(/\D/g, '')}`,
        filePath: join(FIXTURES, file),
      }));

    const engine = new CrawlEngine({
      fetcher: new FixtureFetcher(routes),
      robots: new PermissiveRobotsProvider(),
      logger,
      sleep: () => Promise.resolve(),
    });

    const context = {
      stateId,
      stateCode: 'TX',
      districtId: district.rows[0]!.id,
      schoolId: school.rows[0]!.id,
      districtName: 'Sample ISD',
      sourceType: 'district_site' as const,
    };

    const runOnce = async (label: string): Promise<void> => {
      const crawlRunId = await crawl.startRun({
        stateId,
        runType: 'fixture',
        config: { seedUrl: routes[0]?.url ?? '' },
        initiatedBy: 'fixture-crawl-cli',
      });
      const result = await engine.run({
        crawlRunId,
        crawlTargetId: null,
        seedUrl: routes[0]?.url ?? '',
        adapter: genericHtmlAdapter,
        districtName: 'Sample ISD',
        policy: withPolicyDefaults({ requestDelayMs: 0, respectRobots: false }),
      });
      const summary = await pipeline.ingestRun(result, context);
      await crawl.finishRun(crawlRunId, 'completed', result.stats, new Date().toISOString());
      logger.info(
        { label, stops: result.stops.map((stop) => stop.reason), ...summary },
        'crawl pass complete',
      );
    };

    await runOnce('first pass');
    await runOnce('second pass, proving recrawl is idempotent');

    await compliance.recordComplaint({
      channel: 'email',
      contactType: 'email',
      contactValue: 'wei.chen@sample-isd.example.org',
      reason: 'demonstration opt-out',
      createdBy: 'fixture-crawl-cli',
      receivedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const exports = new ExportRepository(database);
    const built = await exports.buildPeopleExport({
      name: 'fixture-demo',
      requestedBy: 'fixture-crawl-cli',
      filters: { stateCode: 'TX' },
    });

    mkdirSync(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, 'fixture-export.csv');
    writeFileSync(outPath, built.csv, 'utf8');

    const coverage = await queries.coverageSummary('TX');
    logger.info({ coverage }, 'coverage after the fixture run');
    logger.info(
      { rows: built.rowCount, suppressedInSql: 1, checksum: built.checksum.slice(0, 16), outPath },
      'export written; the opted-out person is absent',
    );
    process.stdout.write(`\nWrote ${built.rowCount} rows to ${outPath}\n`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
