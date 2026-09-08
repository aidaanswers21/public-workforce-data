import { afterEach, describe, expect, it } from 'vitest';
import {
  CrawlEngine,
  PermissiveRobotsProvider,
  fixedClock,
  normalizeOrganizationName,
} from '@public-workforce/core';
import { createSilentLogger } from '@public-workforce/observability';
import { genericHtmlAdapter } from '@public-workforce/adapter-generic-html';
import {
  ComplianceRepository,
  CrawlRepository,
  ExportRepository,
  ExportPurposeRepository,
  IngestionRepository,
  OrganizationRepository,
  QueryRepository,
  TestDatabase,
  seedReferenceData,
} from '@public-workforce/database';
import {
  FixtureFetcher,
  IngestionPipeline,
  buildCrawlPolicy,
  buildTaxonomy,
  buildTitleRuleSet,
  type IngestContext,
} from '@public-workforce/crawler-worker';
import { educationSectorPack } from '@public-workforce/sector-education';
import { federalGovernmentSectorPack } from '@public-workforce/sector-federal';
import { stateLocalGovernmentSectorPack } from '@public-workforce/sector-state-local';
import type { Uuid } from '@public-workforce/shared-types';
import { fixturePath } from './support/fixtures.js';

const CLOCK = fixedClock('2026-06-01T00:00:00.000Z');
const AT = '2026-06-01T00:00:00.000Z';
const EFFECTIVE_FROM = '2026-01-01T00:00:00.000Z';
const PURPOSE = 'internal-review';
const SEED_URL = 'https://sample-isd.example.org/staff-directory?page=1';
const SECTORS = [educationSectorPack, stateLocalGovernmentSectorPack, federalGovernmentSectorPack];

const TAXONOMY = buildTaxonomy();
// The worked example is an independent school district: education-sector work
// at the special-district level. Both halves decide which packs may read it.
const SCOPE = { sectorCode: 'education', governmentLevelCode: 'special_district' } as const;
const TITLE_RULES = buildTitleRuleSet(TAXONOMY, SCOPE);
const VOCABULARY = TAXONOMY.forScope(SCOPE).vocabulary;

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
  districtId: Uuid;
  schoolId: Uuid;
  jurisdictionId: Uuid;
  startRun: () => Promise<Uuid>;
  runCrawl: (crawlRunId: Uuid) => Promise<Awaited<ReturnType<CrawlEngine['run']>>>;
}

/**
 * The education fixture crawl, on the neutral model.
 *
 * The organization happens to be a school; nothing the pipeline does depends on
 * that. `tests/extensibility.test.ts` runs the same code paths for federal,
 * state, county and municipal bodies.
 */
async function harness(): Promise<Harness> {
  const database = await TestDatabase.create({ sectors: SECTORS });
  open = database;
  await seedReferenceData(database, TAXONOMY);

  const ingestion = new IngestionRepository(database);
  const organizations = new OrganizationRepository(database);
  const crawl = new CrawlRepository(database);
  const logger = createSilentLogger();

  const bootstrap = await ingestion.recordSourceDocument({
    url: 'https://sample-isd.example.org/',
    urlCanonical: 'https://sample-isd.example.org/',
    urlHash: 'bootstrap',
    domain: 'sample-isd.example.org',
    sourceTypeCode: 'manual_entry',
    httpStatus: 200,
    contentHash: null,
    contentType: 'text/html',
    storageKey: null,
    robotsAllowed: true,
    robotsPolicyNote: 'seeded for local development',
    crawlRunId: null,
    retrievedAt: AT,
  });

  const stateArea = await organizations.upsertGeographicArea({
    areaTypeCode: 'state',
    name: 'Texas',
    nameNormalized: 'texas',
    stateCode: 'TX',
  });
  const countyArea = await organizations.upsertGeographicArea({
    areaTypeCode: 'county',
    name: 'Harris',
    nameNormalized: 'harris',
    parentAreaId: stateArea,
    stateCode: 'TX',
  });
  const jurisdictionId = await organizations.upsertJurisdiction({
    code: 'us-tx-education',
    name: 'Texas public education',
    governmentLevelCode: 'special_district',
    geographicAreaId: stateArea,
  });

  const common = {
    sourceDocumentId: bootstrap.documentId,
    extractionMethod: 'file_import' as const,
    confidence: 1,
    observedAt: AT,
  };
  const suffixes = TAXONOMY.vocabulary.organizationNameSuffixes;

  const district = await organizations.upsertOrganization({
    organizationTypeCode: 'school_district',
    governmentLevelCode: 'special_district',
    sectorCode: 'education',
    jurisdictionId,
    name: 'Sample Independent School District',
    nameNormalized: normalizeOrganizationName('Sample Independent School District', suffixes),
    primaryDomain: 'sample-isd.example.org',
    ...common,
  });
  const school = await organizations.upsertOrganization({
    organizationTypeCode: 'school',
    governmentLevelCode: 'special_district',
    sectorCode: 'education',
    jurisdictionId,
    name: 'Sample High School',
    nameNormalized: normalizeOrganizationName('Sample High School', suffixes),
    ...common,
  });
  await organizations.upsertRelationship({
    parentOrganizationId: district.id,
    childOrganizationId: school.id,
    relationshipTypeCode: 'part_of',
    effectiveFrom: '2020-08-01',
    ...common,
  });
  const dutyLocation = await organizations.upsertLocation({
    organizationId: school.id,
    city: 'Houston',
    stateCode: 'TX',
    geographicAreaId: countyArea,
    ...common,
  });
  expect(dutyLocation).toBeTruthy();

  const engine = new CrawlEngine({
    fetcher: new FixtureFetcher(ROUTES),
    robots: new PermissiveRobotsProvider(),
    logger,
    clock: CLOCK,
    sleep: () => Promise.resolve(),
  });

  await new ExportPurposeRepository(database).approve({
    code: PURPOSE,
    description: 'Fixture-only internal review export.',
    owner: 'test',
    approvedBy: 'test',
    approvedAt: AT,
  });

  return {
    database,
    pipeline: new IngestionPipeline({ ingestion, crawl, organizations, logger, clock: CLOCK }),
    crawl,
    compliance: new ComplianceRepository(database),
    queries: new QueryRepository(database),
    districtId: district.id,
    schoolId: school.id,
    jurisdictionId,
    context: {
      organizationId: school.id,
      organizationName: 'Sample High School',
      governmentLevelCode: 'special_district',
      sectorCode: 'education',
      jurisdictionId,
      sourceTypeCode: 'html_directory',
      vocabulary: VOCABULARY,
      titleRules: TITLE_RULES,
    },
    startRun: () =>
      crawl.startRun({
        jurisdictionId,
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
        organizationName: 'Sample High School',
        parentOrganizationName: 'Sample Independent School District',
        vocabulary: TAXONOMY.vocabulary,
        collectionMode: 'fixture',
        policy: buildCrawlPolicy({ requestDelayMs: 0, respectRobots: false }),
      }),
  };
}

describe('fixture collection, end to end', () => {
  it('collects three pages and stores every published person with provenance', async () => {
    const h = await harness();
    const result = await h.runCrawl(await h.startRun());
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

    // Provenance is a NOT NULL foreign key now, so this cannot be non-zero.
    // Asserted anyway: it is the guarantee, and a schema change that relaxed it
    // should fail here rather than only in the migration test.
    expect(await h.database.count('people', 'source_document_id is null')).toBe(0);
    expect(await h.database.count('source_observations')).toBeGreaterThanOrEqual(
      summary.peopleSeen,
    );
  });

  it('stores response metadata from the fetch instead of substituting defaults', async () => {
    const h = await harness();
    const result = await h.runCrawl(await h.startRun());
    const first = result.records[0];
    if (first === undefined) throw new Error('fixture produced no records');
    result.records = [
      {
        ...first,
        httpStatus: 206,
        contentType: 'text/html; charset=windows-1252',
        robotsAllowed: null,
        robotsPolicyNote: null,
      },
    ];
    await h.pipeline.ingestRun(result, h.context);

    const stored = await h.database.query<{
      http_status: number | null;
      content_type: string | null;
      robots_allowed: boolean | null;
    }>(
      `select http_status, content_type, robots_allowed
       from source_document_versions
       where source_document_id in (
         select id from source_documents where url_canonical = $1
       )`,
      [first.sourceUrl],
    );
    expect(stored.rows[0]).toMatchObject({
      http_status: 206,
      content_type: 'text/html; charset=windows-1252',
      robots_allowed: null,
    });
  });

  it('tags employment evidence separately from contact evidence', async () => {
    const h = await harness();
    await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);
    expect(
      await h.database.count('source_observations', "evidence_class = 'employment'"),
    ).toBeGreaterThan(0);
    expect(
      await h.database.count('source_observations', "evidence_class = 'contact'"),
    ).toBeGreaterThan(0);
  });

  it('stores the published phone as a professional contact point', async () => {
    const h = await harness();
    const summary = await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);
    expect(summary.contactPoints).toBeGreaterThan(0);
    expect(
      await h.database.count('contact_points', "contact_point_type_code = 'work_phone'"),
    ).toBeGreaterThan(0);
  });

  it('normalizes names and titles through the composed taxonomy', async () => {
    const h = await harness();
    await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);

    const rows = await h.database.query<{
      first_name: string;
      last_name: string;
      role_category_code: string;
      job_family_code: string;
    }>(
      `select p.first_name, p.last_name, e.role_category_code, e.job_family_code
       from people p join employment_assignments e on e.person_id = p.id`,
    );
    const byLastName = new Map(rows.rows.map((row) => [row.last_name, row]));

    expect(byLastName.get('Rivera')).toMatchObject({
      first_name: 'Ana',
      role_category_code: 'school_principal',
    });
    expect(byLastName.get("O'Brien")).toMatchObject({ role_category_code: 'school_counselor' });
    expect(byLastName.get('Van Der Berg')).toMatchObject({
      first_name: 'Thomas',
      role_category_code: 'custodial',
    });
    expect(byLastName.get('Smith')).toMatchObject({
      first_name: 'Robert',
      role_category_code: 'coach_athletics',
    });
    expect(byLastName.get('Okafor')).toMatchObject({ role_category_code: 'food_services' });
    expect(byLastName.get('Nguyen')).toMatchObject({
      role_category_code: 'transportation_operations',
    });
  });

  it('records which rule pack and taxonomy version produced each normalization', async () => {
    const h = await harness();
    await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);
    const rows = await h.database.query<{
      normalization_rule_source: string;
      taxonomy_version: string;
    }>(`select normalization_rule_source, taxonomy_version from employment_assignments limit 1`);
    expect(rows.rows[0]?.normalization_rule_source).toBeTruthy();
    expect(rows.rows[0]?.taxonomy_version).toBe(TITLE_RULES.version);
  });

  it('a second identical collection creates no duplicate rows', async () => {
    const h = await harness();
    const first = await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);
    expect(first.peopleCreated).toBe(9);

    const second = await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);
    expect(second.peopleCreated).toBe(0);
    expect(second.peopleSeen).toBe(9);

    expect(await h.database.count('people')).toBe(9);
    expect(await h.database.count('employment_assignments')).toBe(9);
    expect(await h.database.count('email_addresses')).toBe(9);
    expect(await h.database.count('contact_points')).toBe(first.contactPoints);
  });

  it('exports with organization, level and jurisdiction columns', async () => {
    const h = await harness();
    await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);

    const exports = new ExportRepository(h.database);
    const built = await exports.buildPeopleExport({
      name: 'fixture',
      requestedBy: 'test',
      purpose: PURPOSE,
      filters: { sectorCode: 'education' },
    });

    expect(built.rowCount).toBe(8);
    expect(built.csv).toContain('ana.rivera@sample-isd.example.org');
    expect(built.csv).not.toContain('office@sample-isd.example.org');

    const header = (built.csv.split('\r\n')[0] ?? '').split(',');
    for (const column of [
      'organization',
      'organization_type',
      'parent_organization',
      'government_level',
      'sector',
      'jurisdiction',
      'published_email',
      'inferred_email_candidate',
      'source_url',
    ]) {
      expect(header).toContain(column);
    }

    const rivera = built.csv.split('\r\n').find((line) => line.includes('ana.rivera')) ?? '';
    expect(rivera).toContain('Sample High School');
    expect(rivera).toContain('Sample Independent School District');
    expect(rivera).toContain('education');
  });

  it('a suppressed person cannot reach an export, even after appearing in an earlier one', async () => {
    const h = await harness();
    await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);
    const exports = new ExportRepository(h.database);

    const before = await exports.buildPeopleExport({
      name: 'before',
      requestedBy: 'test',
      purpose: PURPOSE,
      filters: {},
    });
    expect(before.csv).toContain('wei.chen@sample-isd.example.org');

    await h.compliance.recordComplaint({
      idempotencyKey: 'end-to-end-opt-out',
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
      purpose: PURPOSE,
      filters: {},
    });
    expect(after.csv).not.toContain('wei.chen@sample-isd.example.org');
    expect(after.rowCount).toBe(before.rowCount - 1);
    expect(
      await h.database.count('email_addresses', "address = 'wei.chen@sample-isd.example.org'"),
    ).toBe(1);
  });

  it('suppressing the parent organization withholds everyone at the school beneath it', async () => {
    const h = await harness();
    await h.pipeline.ingestRun(await h.runCrawl(await h.startRun()), h.context);
    const exports = new ExportRepository(h.database);
    expect(
      (
        await exports.buildPeopleExport({
          name: 'before',
          requestedBy: 'test',
          purpose: PURPOSE,
          filters: {},
        })
      ).rowCount,
    ).toBe(8);

    await h.compliance.addSuppression({
      scope: 'organization_subtree',
      value: h.districtId,
      organizationId: h.districtId,
      reason: 'the district asked not to be contacted',
      source: 'opt_out_request',
      createdBy: 'ops',
      effectiveAt: EFFECTIVE_FROM,
    });

    const after = await exports.buildPeopleExport({
      name: 'after',
      requestedBy: 'test',
      purpose: PURPOSE,
      filters: {},
    });
    expect(after.rowCount).toBe(0);
  });

  it('records a collection run that coverage reporting can read', async () => {
    const h = await harness();
    const runId = await h.startRun();
    const result = await h.runCrawl(runId);
    await h.pipeline.ingestRun(result, h.context);
    const finishedAt = new Date().toISOString();
    await h.crawl.finishRun(runId, 'completed', result.stats, finishedAt);

    const summary = await h.queries.coverageSummary({ sectorCode: 'education' });
    expect(summary).toMatchObject({
      organizations: 2,
      people: 9,
      publishedEmails: 8,
      generalInboxes: 1,
      relationships: 1,
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
    for (const key of checkpoint?.seenRecordKeys ?? []) expect(key).toMatch(/^[0-9a-f]{64}$/);
    const persisted = await h.database.query<{ payload: string }>(
      `select payload::text as payload from crawl_checkpoints where crawl_run_id = $1`,
      [runId],
    );
    for (const raw of ['Wei Chen', 'wei.chen@sample-isd.example.org', 'readable-valid-key']) {
      expect(persisted.rows[0]?.payload).not.toContain(raw);
    }
  });

  it('refuses to persist a readable record fingerprint in a checkpoint', async () => {
    const h = await harness();
    const runId = await h.startRun();
    await expect(
      h.crawl.saveCheckpoint({
        crawlRunId: runId,
        crawlTargetId: null,
        pendingTasks: [],
        visitedUrlHashes: [],
        seenContentHashes: [],
        seenRecordKeys: ['Jamie Fields|Student|Example'],
        pagesFetched: 0,
        updatedAt: AT,
      }),
    ).rejects.toThrow(/opaque SHA-256/);
    expect(await h.database.count('crawl_checkpoints')).toBe(0);
  });

  it('never persists a value the data boundary rejected', async () => {
    // The boundary used to be a scan whose result was counted and then ignored:
    // the raw record went on to the person row, the unit, the contact point and
    // the observations. This drives one poisoned record through the real
    // pipeline and then looks for its values everywhere they could have landed.
    const h = await harness();
    const runId = await h.startRun();
    const poisoned = {
      ...(await h.runCrawl(runId)),
      records: [
        {
          record: {
            recordKey: 'poisoned:1',
            fullNamePublished: 'Jamie Fields, Class of 2027',
            titlePublished: 'Student',
            departmentPublished: 'home address: 12 Privet Drive',
            organizationPublished: null,
            phonePublished: null,
            emails: [],
            profileUrl: null,
            extractionMethod: 'html_table' as const,
            confidence: 0.9,
            selector: 'table > tr',
            snippet: null,
          },
          sourceUrl: SEED_URL,
          sourceContentHash: 'poisoned',
          fetchedAt: AT,
          httpStatus: 200,
          contentType: 'text/html',
          robotsAllowed: null,
          robotsPolicyNote: null,
          depth: 0,
          pageContext: {},
        },
      ],
    };

    const summary = await h.pipeline.ingestRun(poisoned, h.context);

    // The name itself was out of scope, so there is no person at all.
    expect(summary.boundaryDrops).toBeGreaterThan(0);
    expect(summary.peopleCreated).toBe(0);

    for (const [table, column] of [
      ['people', 'full_name_published'],
      ['employment_assignments', 'title_published'],
      ['employment_assignments', 'department_published'],
      ['organizational_units', 'name_source_value'],
      ['source_observations', 'value_raw'],
      ['source_observations', 'value_normalized'],
      ['contact_points', 'source_value'],
    ] as const) {
      const hits = await h.database.count(
        table,
        `${column} ilike '%Privet%' or ${column} ilike '%Class of 2027%'`,
      );
      expect(hits, `${table}.${column}`).toBe(0);
    }
  });

  it('keeps a legitimate title that merely contains a sensitive word', async () => {
    const h = await harness();
    const runId = await h.startRun();
    const record = {
      ...(await h.runCrawl(runId)),
      records: [
        {
          record: {
            recordKey: 'legitimate:1',
            fullNamePublished: 'Dana Lee',
            titlePublished: 'Director of Student Services',
            departmentPublished: 'Student Services',
            organizationPublished: null,
            phonePublished: null,
            emails: [],
            profileUrl: null,
            extractionMethod: 'html_table' as const,
            confidence: 0.9,
            selector: 'table > tr',
            snippet: null,
          },
          sourceUrl: SEED_URL,
          sourceContentHash: 'legitimate',
          fetchedAt: AT,
          httpStatus: 200,
          contentType: 'text/html',
          robotsAllowed: null,
          robotsPolicyNote: null,
          depth: 0,
          pageContext: {},
        },
      ],
    };

    const summary = await h.pipeline.ingestRun(record, h.context);
    expect(summary.boundaryDrops).toBe(0);
    expect(summary.peopleCreated).toBe(1);
    expect(
      await h.database.count(
        'employment_assignments',
        `title_published = 'Director of Student Services'`,
      ),
    ).toBe(1);
  });
});
