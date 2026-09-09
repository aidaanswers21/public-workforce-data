import { afterEach, describe, expect, it } from 'vitest';
import {
  TestDatabase,
  CollectionProjectRepository,
  IngestionRepository,
  OrganizationRepository,
  OrganizationSpineImportRepository,
  SourcePolicyRepository,
  loadSourcePolicyRegistry,
  ExportRepository,
  ExportPurposeRepository,
} from '@public-workforce/database';
import { educationSectorPack } from '@public-workforce/sector-education';
import { DiscoveryWorker } from '@public-workforce/discovery-worker';
import {
  buildAdapterRegistry,
  buildScopedRules,
  buildTaxonomy,
  ProductionCollectionExecutor,
  CollectionWorker,
} from '@public-workforce/crawler-worker';
import { PermissiveRobotsProvider, contentHash } from '@public-workforce/core';
import { createSilentLogger } from '@public-workforce/observability';
import type { Fetcher } from '@public-workforce/shared-types';

let db: TestDatabase;
afterEach(async () => {
  await db?.close();
});
const root = 'https://directory.example.test/';
const listing =
  '<h1>Staff Directory</h1><table><tr><th>Name</th><th>Title</th><th>Email</th><th>Phone</th></tr><tr><td>Alex Rivera</td><td>Director</td><td><a href="mailto:alex@district.example.test">alex@district.example.test</a></td><td>512-555-0123 ext 4</td></tr></table>';
async function setup() {
  db = await TestDatabase.create({ sectors: [educationSectorPack] });
  const document = await new IngestionRepository(db).recordSourceDocument({
    url: root,
    urlCanonical: root,
    urlHash: 'bootstrap',
    domain: 'directory.example.test',
    sourceTypeCode: 'html_directory',
    httpStatus: 200,
    contentHash: 'bootstrap',
    contentType: 'text/html',
    storageKey: null,
    robotsAllowed: true,
    robotsPolicyNote: null,
    crawlRunId: null,
    retrievedAt: new Date().toISOString(),
  });
  const organization = await new OrganizationRepository(db).upsertOrganization({
    organizationTypeCode: 'school_district',
    governmentLevelCode: 'special_district',
    sectorCode: 'education',
    name: 'Fixture District',
    nameNormalized: 'fixture district',
    websiteUrl: root,
    sourceDocumentId: document.documentId,
    extractionMethod: 'bulk_import',
    confidence: 1,
    observedAt: new Date().toISOString(),
    identifier: { systemCode: 'nces_district_id', value: '1234567' },
  });
  const organizationId = organization.id;
  await db.query(
    `insert into organization_locations(organization_id,state_code,is_primary,source_document_id,extraction_method_code,confidence) values($1,'TX',true,$2,'bulk_import',1)`,
    [organizationId, document.documentId],
  );
  const projects = new CollectionProjectRepository(db);
  const input = {
    key: 'statewide-fixture',
    name: 'Statewide fixture',
    jurisdictionConfigKey: 'fixture',
    jurisdictionCode: 'fixture',
    stateCode: 'TX',
    sectorCodes: ['education'],
    governmentLevelCodes: ['special_district'],
    batchSize: 1000,
    maxPagesPerTarget: 20,
    maxPagesPerBatch: 100,
    maxErrorsPerBatch: 10,
    createdBy: 'owner',
  };
  const projectId = await projects.create(input);
  const policies = new SourcePolicyRepository(db);
  await policies.recordReview({
    domain: 'example.test',
    collectionStatus: 'permitted',
    commercialUseStatus: 'unknown',
    automatedAccessStatus: 'permitted',
    solicitationStatus: 'unknown',
    reviewNotes: 'Saved fixture only',
    reviewedBy: 'owner',
  });
  const pages = new Map([
    [
      root,
      '<h1>Welcome</h1><nav><a href="/about">About</a><a href="https://outside.invalid/staff">Staff</a></nav>',
    ],
    [`${root}about`, '<h1>About us</h1><a href="/directory">Staff Directory</a>'],
    [`${root}directory`, listing],
  ]);
  const fetched: string[] = [];
  const fetcher: Fetcher = {
    key: 'fixture',
    fetch: (request) => {
      fetched.push(request.url);
      const body = pages.get(request.url);
      return Promise.resolve(
        body === undefined
          ? {
              ok: false,
              failure: {
                url: request.url,
                errorType: 'http_error',
                message: 'fixture absent',
                status: 404,
                retryable: false,
              },
            }
          : {
              ok: true,
              page: {
                url: request.url,
                finalUrl: request.url,
                status: 200,
                headers: {},
                body,
                contentType: 'text/html',
                contentHash: contentHash(body),
                fetchedAt: new Date().toISOString(),
                fromCache: true,
                storageKey: 'fixture:local',
              },
            },
      );
    },
  };
  const taxonomy = buildTaxonomy();
  const rules = buildScopedRules(taxonomy, {
    governmentLevelCode: 'special_district',
    sectorCode: 'education',
  });
  const adapters = buildAdapterRegistry();
  const robots = new PermissiveRobotsProvider();
  const logger = createSilentLogger();
  const sourcePolicy = await loadSourcePolicyRegistry(db);
  const discovery = () =>
    new DiscoveryWorker({
      client: db,
      fetcher,
      robots,
      logger,
      adapters,
      vocabulary: rules.vocabulary,
      sourcePolicy,
      collectionMode: 'fixture',
      sleep: () => Promise.resolve(),
    });
  const target = {
    organizationId,
    jurisdictionId: null,
    siteUrl: root,
    organizationName: 'Fixture District',
    parentOrganizationName: null,
  };
  return {
    projects,
    projectId,
    input,
    organizationId,
    document,
    fetcher,
    pages,
    fetched,
    taxonomy,
    rules,
    adapters,
    robots,
    logger,
    sourcePolicy,
    discovery,
    target,
  };
}
describe('statewide collection', () => {
  it('finds a directory through an ordinary homepage and intermediate navigation', async () => {
    const s = await setup();
    const result = await s.discovery().discover(s.target);
    expect(result).toMatchObject({
      outcome: 'completed',
      targetsRecorded: 1,
      pagesProcessed: 3,
      partial: false,
    });
    expect(result.candidates[0]).toMatchObject({
      url: `${root}directory`,
      adapterKey: 'generic-html',
    });
    expect(s.fetched).not.toContain('https://outside.invalid/staff');
  });
  it.each([403, 500])(
    'reports HTTP %s as a real failure, with no fictitious page',
    async (status) => {
      const s = await setup();
      const worker = new DiscoveryWorker({
        client: db,
        fetcher: {
          key: 'fixture',
          fetch: () =>
            Promise.resolve({
              ok: false,
              failure: {
                url: root,
                status,
                errorType: status === 403 ? 'blocked_by_source' : 'http_error',
                message: `HTTP ${status}`,
                retryable: status === 500,
              },
            }),
        },
        robots: s.robots,
        logger: s.logger,
        adapters: s.adapters,
        vocabulary: s.rules.vocabulary,
        collectionMode: 'fixture',
      });
      expect(await worker.discover(s.target)).toMatchObject({
        outcome: status === 403 ? 'blocked' : 'failed',
        pagesProcessed: 0,
        retryable: status === 500,
      });
    },
  );
  it('runs discovery through ingestion and phone export after one approval', async () => {
    const s = await setup();
    await s.projects.generateDiscoveryTargets(s.projectId, 'owner');
    const batchId = await s.projects.createApprovedRun({
      projectId: s.projectId,
      approvedBy: 'owner',
      approvalNote: 'Approve the complete fixture run',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const executor = new ProductionCollectionExecutor({
      client: db,
      fetcher: s.fetcher,
      robots: s.robots,
      adapters: s.adapters,
      taxonomy: s.taxonomy,
      logger: s.logger,
      workerId: 'fixture',
      sleep: () => Promise.resolve(),
      discover: async () => {
        const r = await s.discovery().discover(s.target);
        return {
          pagesProcessed: r.pagesProcessed,
          targetsRecorded: r.targetsRecorded,
          outcome: r.outcome,
          detail: r.note,
        };
      },
    });
    const worker = new CollectionWorker({
      queue: s.projects,
      executor,
      workerId: 'fixture',
      logger: s.logger,
      batchId,
    });
    expect(await worker.drainApprovedBatch()).toEqual({ completed: 2, failed: 0, held: 0 });
    expect(await db.count('people')).toBe(1);
    expect((await s.projects.listBatches(s.projectId))[0]).toMatchObject({
      status: 'completed',
      completedJobs: 2,
    });
    await new ExportPurposeRepository(db).approve({
      code: 'fixture-export',
      description: 'Export the fixture contacts',
      owner: 'owner',
      approvedBy: 'owner',
    });
    const chunks: string[] = [];
    const result = await new ExportRepository(db).streamPeopleExport(
      {
        name: 'All contacts',
        requestedBy: 'owner',
        purpose: 'fixture-export',
        filters: { collectionProjectId: s.projectId },
      },
      (chunk) => {
        chunks.push(chunk);
        return Promise.resolve();
      },
    );
    expect(result.rowCount).toBe(1);
    expect(chunks.join('')).toContain('alex@district.example.test');
    expect(chunks.join('')).toContain('512-555-0123');
    await db.query('delete from email_addresses');
    const phoneChunks: string[] = [];
    const phoneExport = await new ExportRepository(db).streamPeopleExport(
      {
        name: 'Phone-only contacts',
        requestedBy: 'owner',
        purpose: 'fixture-export',
        filters: { collectionProjectId: s.projectId },
      },
      (chunk) => {
        phoneChunks.push(chunk);
        return Promise.resolve();
      },
    );
    expect(phoneExport.rowCount).toBe(1);
    expect(phoneChunks.join('')).toContain('512-555-0123');
    expect(phoneChunks.join('')).not.toContain('alex@district.example.test');
  });
  it('allows known public identity with unknown government level without inventing classification', async () => {
    const s = await setup();
    const importer = new OrganizationSpineImportRepository(db);
    await importer.stage([
      {
        sourceKey: 'fixture-roster',
        sourceRecordKey: 'unknown-level',
        name: 'Known District',
        nameNormalized: 'known district',
        organizationTypeCode: 'school_district',
        governmentLevelCode: null,
        sectorCode: 'education',
        classificationReviewReason: 'Government level not published',
        jurisdictionId: null,
        websiteValueRaw: 'https://known.example.test',
        websiteUrl: 'https://known.example.test',
        primaryDomain: 'known.example.test',
        identifiers: [{ systemCode: 'nces_district_id', value: '2345678', issuingStateCode: null }],
        parentIdentifiers: [],
        location: { stateCode: 'TX' },
        attributes: {},
        status: 'classification_hold',
        sourceDocumentId: s.document.documentId,
        sourceDocumentVersionId: s.document.versionId,
        sourceEffectiveDate: null,
        observedAt: new Date().toISOString(),
      },
    ]);
    const id = await s.projects.prepareRoster(
      { ...s.input, key: 'unknown-roster' },
      ['fixture-roster'],
      ['TX'],
    );
    expect((await s.projects.get(id))?.organizationsSelected).toBe(2);
    const record = (
      await db.query<{ government_level_code: null; status: string; organization_id: string }>(
        `select government_level_code,status,organization_id from organization_spine_records where source_record_key='unknown-level'`,
      )
    ).rows[0];
    expect(record?.government_level_code).toBeNull();
    expect(record?.organization_id).toBeTruthy();
    expect(record?.status).toBe('classification_hold');
  });
  it('charges requests before transport and refuses expired claims', async () => {
    const s = await setup();
    await db.query('update collection_projects set max_pages_per_batch=2 where id=$1', [
      s.projectId,
    ]);
    await s.projects.generateDiscoveryTargets(s.projectId, 'owner');
    const batchId = await s.projects.createApprovedRun({
      projectId: s.projectId,
      approvedBy: 'owner',
      approvalNote: 'Approve bounded fixture collection',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const job = await s.projects.claimNextJob('fixture', 300, batchId);
    if (job === null) throw new Error('no job');
    await s.projects.markJobRunning(job.id, job.claimToken, null);
    await s.projects.reserveRequest(job.id, job.claimToken);
    await s.projects.reserveRequest(job.id, job.claimToken);
    await expect(s.projects.reserveRequest(job.id, job.claimToken)).rejects.toThrow(
      /budget reached/,
    );
    expect((await s.projects.listBatches(s.projectId))[0]?.pagesProcessed).toBe(2);
    await db.query(
      "update collection_jobs set lease_expires_at=now()-interval '1 second' where id=$1",
      [job.id],
    );
    await expect(s.projects.renewLease(job.id, job.claimToken)).rejects.toThrow(/expired/);
    await expect(
      s.projects.completeJob({
        jobId: job.id,
        claimToken: job.claimToken,
        crawlRunId: null,
        pagesProcessed: 2,
        recordsCollected: 0,
      }),
    ).rejects.toThrow(/claim/);
  });
  it('freezes the approved roster and does not impose the legacy 1000-target cap', async () => {
    const s = await setup();
    await db.query(
      `insert into organizations(organization_type_code,government_level_code,sector_code,name,name_normalized,website_url,identity_tier,identity_fingerprint,source_document_id,extraction_method_code,confidence)
      select 'school_district','special_district','education','District '||n,'district '||n,'https://d'||n||'.example.test/','official_identifier','fixture:'||n,$1,'bulk_import',1 from generate_series(1,1001)n`,
      [s.document.documentId],
    );
    await db.query(
      `insert into collection_project_organizations select $1,id,'fixture scope',now() from organizations on conflict do nothing`,
      [s.projectId],
    );
    await s.projects.generateDiscoveryTargets(s.projectId, 'owner');
    const batchId = await s.projects.createApprovedRun({
      projectId: s.projectId,
      approvedBy: 'owner',
      approvalNote: 'Approve this complete fixture roster',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(await db.count('collection_jobs', 'batch_id=$1', [batchId])).toBe(1002);
    expect(await db.count('collection_batch_organizations', 'batch_id=$1', [batchId])).toBe(1002);
  });
  it('streams beyond one chunk and rechecks suppression between chunks', async () => {
    const s = await setup();
    await db.query(
      `insert into people(full_name_published,identity_key,source_document_id,extraction_method_code,confidence)
      select 'Person '||n,'export-fixture:'||n,$1,'html_table',1 from generate_series(1,2005)n`,
      [s.document.documentId],
    );
    await db.query(
      `insert into employment_assignments(person_id,organization_id,source_document_id,extraction_method_code,confidence)
      select id,$1,$2,'html_table',1 from people`,
      [s.organizationId, s.document.documentId],
    );
    await db.query(
      `insert into email_addresses(person_id,organization_id,address,address_normalized,domain,local_part,classification,source_document_id,extraction_method_code,confidence)
      select id,$1,replace(identity_key,':','')||'@example.test',replace(identity_key,':','')||'@example.test','example.test',replace(identity_key,':',''),'published',$2,'html_table',1 from people`,
      [s.organizationId, s.document.documentId],
    );
    await new ExportPurposeRepository(db).approve({
      code: 'stream-fixture',
      description: 'Fixture streaming export',
      owner: 'owner',
      approvedBy: 'owner',
    });
    const exporter = new ExportRepository(db);
    const input = {
      name: 'Complete',
      requestedBy: 'owner',
      purpose: 'stream-fixture',
      filters: { collectionProjectId: s.projectId },
    };
    const chunks: string[] = [];
    expect(
      (
        await exporter.streamPeopleExport(input, (chunk) => {
          chunks.push(chunk);
          return Promise.resolve();
        })
      ).rowCount,
    ).toBe(2005);
    expect(chunks.length).toBe(2);
    expect(chunks.join('').match(/all_published_emails/g)?.length).toBe(1);
    let writes = 0;
    const result = await exporter.streamPeopleExport(input, async () => {
      if (writes++ === 0)
        await db.query(
          `insert into suppression_entries(scope,value,organization_id,reason,source,created_by)
        values('organization',$1::text,$1::uuid,'Fixture suppression between chunks','complaint','owner')`,
          [s.organizationId],
        );
    });
    expect(result.rowCount).toBe(2000);
  });
});
