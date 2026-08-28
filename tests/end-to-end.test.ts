import { afterEach, describe, expect, it } from 'vitest';
import { CrawlEngine, PermissiveRobotsProvider, fixedClock, withPolicyDefaults } from '@pan/core';
import { createSilentLogger } from '@pan/observability';
import { genericHtmlAdapter } from '@pan/adapter-generic-html';
import {
  ComplianceRepository,
  CrawlRepository,
  ExportRepository,
  IngestionRepository,
  QueryRepository,
  TestDatabase,
} from '@pan/database';
import { FixtureFetcher, IngestionPipeline, type IngestContext } from '@pan/crawler-worker';
import type { Uuid } from '@pan/shared-types';
import { fixturePath } from './support/fixtures.js';

const CLOCK = fixedClock('2026-06-01T00:00:00.000Z');
const AT = '2026-06-01T00:00:00.000Z';
const EFFECTIVE_FROM = '2026-01-01T00:00:00.000Z';
const SEED_URL = 'https://sample-isd.example.org/staff-directory?page=1';

const ROUTES = [1, 2, 3].map((page) => ({
  url: `https://sample-isd.example.org/staff-directory?page=${page}`,
  filePath: fixturePath(
    'directory-platforms',
    'generic-html',
    'table-numbered',
    `page-${page}.html`,
  ),
}));

let open: TestDatabase | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

interface Harness {
  database: TestDatabase;
  pipeline: IngestionPipeline;
  crawl: CrawlRepository;
  compliance: ComplianceRepository;
  queries: QueryRepository;
  context: IngestContext;
  runCrawl: (crawlRunId: Uuid) => Promise<Awaited<ReturnType<CrawlEngine['run']>>>;
  startRun: () => Promise<Uuid>;
}

async function harness(): Promise<Harness> {
  const database = await TestDatabase.create();
  open = database;

  const ingestion = new IngestionRepository(database);
  const crawl = new CrawlRepository(database);
  const logger = createSilentLogger();

  const bootstrapPageId = await ingestion.upsertSourcePage({
    url: 'https://sample-isd.example.org/',
    urlCanonical: 'https://sample-isd.example.org/',
    urlHash: 'bootstrap',
    domain: 'sample-isd.example.org',
    sourceType: 'file_import',
    httpStatus: 200,
    contentHash: null,
    contentType: 'text/html',
    storageKey: null,
    robotsAllowed: true,
    robotsPolicyNote: 'seeded for local development',
    crawlRunId: null,
    fetchedAt: AT,
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
  const districtId = district.rows[0]!.id;
  const school = await database.query<{ id: Uuid }>(
    `insert into schools (district_id, state_id, county_id, name, name_normalized, source_page_id, extraction_method, confidence)
     values ($1,$2,$3,'Sample High School','sample-high',$4,'file_import',1) returning id`,
    [districtId, stateId, county.rows[0]!.id, bootstrapPageId],
  );

  const engine = new CrawlEngine({
    fetcher: new FixtureFetcher(ROUTES),
    robots: new PermissiveRobotsProvider(),
    logger,
    clock: CLOCK,
    sleep: () => Promise.resolve(),
  });

  return {
    database,
    pipeline: new IngestionPipeline({ ingestion, crawl, logger, clock: CLOCK }),
    crawl,
    compliance: new ComplianceRepository(database),
    queries: new QueryRepository(database),
    context: {
      stateId,
      stateCode: 'TX',
      districtId,
      schoolId: school.rows[0]!.id,
      districtName: 'Sample ISD',
      sourceType: 'district_site',
    },
    startRun: () =>
      crawl.startRun({
        stateId,
        runType: 'fixture',
        config: { seedUrl: SEED_URL },
        initiatedBy: 'test',
      }),
    runCrawl: (crawlRunId) =>
      engine.run({
        crawlRunId,
        crawlTargetId: null,
        seedUrl: SEED_URL,
        adapter: genericHtmlAdapter,
        districtName: 'Sample ISD',
        policy: withPolicyDefaults({ requestDelayMs: 0, respectRobots: false }),
      }),
  };
}

describe('fixture crawl, end to end', () => {
  it('crawls three pages and stores every published person with provenance', async () => {
    const h = await harness();
    const runId = await h.startRun();
    const result = await h.runCrawl(runId);
    const summary = await h.pipeline.ingestRun(result, h.context);

    expect(result.stats.pagesFetched).toBe(3);
    expect(summary.peopleSeen).toBe(9);
    expect(summary.peopleCreated).toBe(9);
    expect(await h.database.count('people')).toBe(9);
    expect(await h.database.count('employment_assignments')).toBe(9);
    expect(await h.database.count('crawl_pages')).toBe(3);

    // Eight person addresses plus one shared office inbox.
    expect(summary.publishedEmails).toBe(8);
    expect(summary.generalInboxes).toBe(1);

    const untraceable = await h.database.count(
      'people',
      'source_page_id is null and inference_evidence_id is null',
    );
    expect(untraceable).toBe(0);

    const observations = await h.database.count('source_observations');
    expect(observations).toBeGreaterThanOrEqual(summary.peopleSeen);
  });

  it('normalizes names, titles and roles from what the pages published', async () => {
    const h = await harness();
    await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);

    const rows = await h.database.query<{
      first_name: string;
      last_name: string;
      role_category: string;
      title_normalized: string;
    }>(
      `select p.first_name, p.last_name, e.role_category, e.title_normalized
       from people p join employment_assignments e on e.person_id = p.id
       order by p.last_name`,
    );
    const byLastName = new Map(rows.rows.map((row) => [row.last_name, row]));

    expect(byLastName.get('Rivera')).toMatchObject({
      first_name: 'Ana',
      role_category: 'principal',
    });
    expect(byLastName.get("O'Brien")).toMatchObject({
      first_name: 'Katherine',
      role_category: 'counselor',
    });
    expect(byLastName.get('Van Der Berg')).toMatchObject({
      first_name: 'Thomas',
      role_category: 'custodial',
    });
    expect(byLastName.get('Smith')).toMatchObject({
      first_name: 'Robert',
      role_category: 'coach_athletics',
    });
    expect(byLastName.get('Okafor')).toMatchObject({ role_category: 'food_service' });
    expect(byLastName.get('Nguyen')).toMatchObject({ role_category: 'transportation' });
  });

  it('a second identical crawl creates no duplicate rows', async () => {
    const h = await harness();
    const first = await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);
    expect(first.peopleCreated).toBe(9);

    const second = await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);
    expect(second.peopleCreated).toBe(0);
    expect(second.peopleSeen).toBe(9);

    expect(await h.database.count('people')).toBe(9);
    expect(await h.database.count('employment_assignments')).toBe(9);
    expect(await h.database.count('email_addresses')).toBe(9);
    expect(await h.database.count('source_pages')).toBe(4);
  });

  it('exports every non-suppressed person with published and inferred columns kept apart', async () => {
    const h = await harness();
    await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);

    const exports = new ExportRepository(h.database);
    const built = await exports.buildPeopleExport({
      name: 'tx-fixture',
      requestedBy: 'test',
      filters: { stateCode: 'TX' },
    });

    // Eight people; the shared office inbox is excluded by default.
    expect(built.rowCount).toBe(8);
    expect(built.csv).toContain('ana.rivera@sample-isd.example.org');
    expect(built.csv).not.toContain('office@sample-isd.example.org');

    const header = built.csv.split('\r\n')[0] ?? '';
    expect(header.split(',')).toContain('published_email');
    expect(header.split(',')).toContain('inferred_email_candidate');
    expect(header.split(',')).toContain('source_url');
    expect(header.split(',')).toContain('first_seen_at');
    expect(header.split(',')).toContain('crawl_run_id');

    const rivera = built.csv.split('\r\n').find((line) => line.includes('ana.rivera')) ?? '';
    expect(rivera).toContain('https://sample-isd.example.org/staff-directory');
    expect(rivera).toContain('Sample ISD');
    expect(rivera).toContain('Harris');
  });

  it('a suppressed person cannot reach an export, even after appearing in an earlier one', async () => {
    const h = await harness();
    await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);
    const exports = new ExportRepository(h.database);

    const before = await exports.buildPeopleExport({
      name: 'before',
      requestedBy: 'test',
      filters: {},
    });
    expect(before.csv).toContain('wei.chen@sample-isd.example.org');

    await h.compliance.recordComplaint({
      channel: 'email',
      contactType: 'email',
      contactValue: 'wei.chen@sample-isd.example.org',
      reason: 'asked to be removed',
      createdBy: 'ops',
      receivedAt: EFFECTIVE_FROM,
    });

    const after = await exports.buildPeopleExport({
      name: 'after',
      requestedBy: 'test',
      filters: {},
    });
    expect(after.csv).not.toContain('wei.chen@sample-isd.example.org');
    expect(after.rowCount).toBe(before.rowCount - 1);
    // Zero, because the data layer filtered the row out in SQL before the
    // export code ever saw it. A non-zero value here would mean an opt-out
    // landed between the query and the write, which the second pass caught.
    expect(after.suppressedCount).toBe(0);

    // The person is still in the database with their evidence intact.
    expect(
      await h.database.count('email_addresses', "address = 'wei.chen@sample-isd.example.org'"),
    ).toBe(1);
  });

  it('records a crawl run that coverage reporting can read', async () => {
    const h = await harness();
    const runId = await h.startRun();
    const result = await h.runCrawl(runId);
    await h.pipeline.ingestRun(result, h.context);
    const finishedAt = new Date().toISOString();
    await h.crawl.finishRun(runId, 'completed', result.stats, finishedAt);

    const summary = await h.queries.coverageSummary('TX');
    expect(summary).toMatchObject({
      stateCode: 'TX',
      districts: 1,
      schools: 1,
      people: 9,
      publishedEmails: 8,
      generalInboxes: 1,
    });
    expect(new Date(summary.lastCrawlAt ?? 0).getTime()).toBe(new Date(finishedAt).getTime());
  });

  it('saves a checkpoint that can be read back', async () => {
    const h = await harness();
    const runId = await h.startRun();
    await h.pipeline.ingestRun(await h.runCrawl(runId), h.context);

    const checkpoint = await h.crawl.loadCheckpoint(runId, null);
    expect(checkpoint?.crawlRunId).toBe(runId);
    expect(checkpoint?.pagesFetched).toBe(3);
    expect(checkpoint?.visitedUrlHashes).toHaveLength(3);
  });
});
