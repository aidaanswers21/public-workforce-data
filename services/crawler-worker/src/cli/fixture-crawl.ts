#!/usr/bin/env node
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrawlEngine, PermissiveRobotsProvider, normalizeOrganizationName } from '@pan/core';
import { createLogger } from '@pan/observability';
import { genericHtmlAdapter } from '@pan/adapter-generic-html';
import {
  ComplianceRepository,
  CrawlRepository,
  ExportRepository,
  IngestionRepository,
  OrganizationRepository,
  QueryRepository,
  TestDatabase,
  seedReferenceData,
} from '@pan/database';
import type { Uuid } from '@pan/shared-types';
import { FixtureFetcher } from '../fetchers/fixture-fetcher.js';
import { IngestionPipeline, type IngestContext } from '../pipeline.js';
import { buildCrawlPolicy, buildTaxonomy, buildTitleRuleSet } from '../registries.js';

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
const EXPORT_PURPOSE = 'internal-review';

/**
 * Runs the whole pipeline against saved fixtures, with no network and no
 * external database.
 *
 * The worked example is an education organization, but nothing it exercises is
 * education-specific: the same code path serves a federal bureau or a county
 * department, which `tests/extensibility.test.ts` proves by constructing both.
 * It crawls, extracts, normalizes, stores with provenance, crawls again to show
 * the recrawl adds nothing, records an opt-out, and writes a CSV excluding it.
 */
async function main(): Promise<void> {
  const logger = createLogger({ name: 'fixture-crawl' });
  const database = await TestDatabase.create();
  const taxonomy = buildTaxonomy();
  const titleRules = buildTitleRuleSet(taxonomy);

  try {
    await seedReferenceData(database, taxonomy);

    const ingestion = new IngestionRepository(database);
    const organizations = new OrganizationRepository(database);
    const crawl = new CrawlRepository(database);
    const compliance = new ComplianceRepository(database);
    const queries = new QueryRepository(database);
    const pipeline = new IngestionPipeline({ ingestion, crawl, organizations, logger });

    const now = new Date().toISOString();
    const bootstrapDocumentId = await ingestion.upsertSourceDocument({
      url: `${HOST}/`,
      urlCanonical: `${HOST}/`,
      urlHash: 'bootstrap',
      domain: 'sample-isd.example.org',
      sourceTypeCode: 'manual_entry',
      httpStatus: 200,
      contentHash: null,
      contentType: 'text/html',
      storageKey: null,
      robotsAllowed: true,
      robotsPolicyNote: 'local fixture seed',
      crawlRunId: null,
      retrievedAt: now,
    });

    // Geography and jurisdiction, kept apart from the employer hierarchy.
    const stateArea = await organizations.upsertGeographicArea({
      areaTypeCode: 'state',
      name: 'Texas',
      nameNormalized: 'texas',
      stateCode: 'TX',
    });
    await organizations.upsertGeographicArea({
      areaTypeCode: 'county',
      name: 'Harris',
      nameNormalized: 'harris',
      parentAreaId: stateArea,
      stateCode: 'TX',
    });
    const jurisdictionId = await organizations.upsertJurisdiction({
      code: 'us-tx-education',
      name: 'Texas public education',
      governmentLevelCode: 'education',
      geographicAreaId: stateArea,
    });

    const suffixes = taxonomy.vocabulary.organizationNameSuffixes;
    const parent = await organizations.upsertOrganization({
      organizationTypeCode: 'school_district',
      governmentLevelCode: 'education',
      sectorCode: 'education',
      jurisdictionId,
      name: 'Sample Independent School District',
      nameNormalized: normalizeOrganizationName('Sample Independent School District', suffixes),
      primaryDomain: 'sample-isd.example.org',
      sourceDocumentId: bootstrapDocumentId,
      extractionMethod: 'manual',
      confidence: 1,
      observedAt: now,
    });
    const child = await organizations.upsertOrganization({
      organizationTypeCode: 'school',
      governmentLevelCode: 'education',
      sectorCode: 'education',
      jurisdictionId,
      name: 'Sample High School',
      nameNormalized: normalizeOrganizationName('Sample High School', suffixes),
      sourceDocumentId: bootstrapDocumentId,
      extractionMethod: 'manual',
      confidence: 1,
      observedAt: now,
    });
    await organizations.upsertRelationship({
      parentOrganizationId: parent.id,
      childOrganizationId: child.id,
      relationshipTypeCode: 'part_of',
      effectiveFrom: '2020-08-01',
      sourceDocumentId: bootstrapDocumentId,
      extractionMethod: 'manual',
      confidence: 1,
      observedAt: now,
    });

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

    const context: IngestContext = {
      organizationId: child.id,
      organizationName: 'Sample High School',
      governmentLevelCode: 'education',
      sectorCode: 'education',
      jurisdictionId,
      sourceTypeCode: 'html_directory',
      vocabulary: taxonomy.vocabulary,
      titleRules,
    };

    const runOnce = async (label: string): Promise<void> => {
      const crawlRunId: Uuid = await crawl.startRun({
        jurisdictionId,
        runType: 'fixture',
        config: { seedUrl: routes[0]?.url ?? '' },
        initiatedBy: 'fixture-crawl-cli',
      });
      const result = await engine.run({
        crawlRunId,
        crawlTargetId: null,
        seedUrl: routes[0]?.url ?? '',
        adapter: genericHtmlAdapter,
        organizationName: 'Sample High School',
        parentOrganizationName: 'Sample Independent School District',
        vocabulary: taxonomy.vocabulary,
        collectionMode: 'fixture',
        policy: buildCrawlPolicy({ requestDelayMs: 0, respectRobots: false }),
      });
      const summary = await pipeline.ingestRun(result, context);
      await crawl.finishRun(crawlRunId, 'completed', result.stats, new Date().toISOString());
      logger.info(
        { label, stops: result.stops.map((stop) => stop.reason), ...summary },
        'collection pass complete',
      );
    };

    await runOnce('first pass');
    await runOnce('second pass, proving a repeat collection is idempotent');

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
      purpose: EXPORT_PURPOSE,
      filters: { sectorCode: 'education' },
    });

    mkdirSync(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, 'fixture-export.csv');
    writeFileSync(outPath, built.csv, 'utf8');

    // The same opt-out mechanism, applied to a whole organization subtree.
    await compliance.addSuppression({
      scope: 'organization_subtree',
      value: parent.id,
      organizationId: parent.id,
      reason: 'demonstration: the parent organization asked not to be contacted',
      source: 'opt_out_request',
      effectiveAt: new Date(Date.now() - 30_000).toISOString(),
      createdBy: 'fixture-crawl-cli',
    });
    const afterSubtree = await exports.buildPeopleExport({
      name: 'fixture-demo-after-subtree',
      requestedBy: 'fixture-crawl-cli',
      purpose: EXPORT_PURPOSE,
      filters: { sectorCode: 'education' },
    });

    const coverage = await queries.coverageSummary({ sectorCode: 'education' });
    logger.info({ coverage }, 'coverage after the fixture run');
    process.stdout.write(
      `\nWrote ${built.rowCount} rows to ${outPath}\n` +
        `After suppressing the parent organization subtree: ${afterSubtree.rowCount} rows\n`,
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
