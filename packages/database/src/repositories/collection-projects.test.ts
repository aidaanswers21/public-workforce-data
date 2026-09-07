import { afterEach, describe, expect, it } from 'vitest';
import { educationSectorPack } from '@public-workforce/sector-education';
import { TestDatabase } from '../testing.js';
import { CollectionProjectRepository } from './collection-projects.js';

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.close();
  database = null;
});

describe('collection project control plane', () => {
  it('materializes scope and creates targets only from published website urls', async () => {
    const setup = await fixture();
    const projectId = await setup.projects.create(projectInput());

    const project = await setup.projects.get(projectId);
    expect(project?.organizationsSelected).toBe(1);
    expect(project?.websitesAvailable).toBe(1);
    expect(project?.estimatedOrganizationCount).toBeNull();

    expect(await setup.projects.generateDiscoveryTargets(projectId, 'owner@example.test')).toBe(1);
    expect(await setup.projects.generateDiscoveryTargets(projectId, 'owner@example.test')).toBe(0);
    expect(await database?.count('crawl_targets')).toBe(1);
  });

  it('uses a location state to scope a national configuration without a jurisdiction row', async () => {
    const setup = await fixture();
    const projectId = await setup.projects.create({
      ...projectInput(),
      jurisdictionConfigKey: 'fixture-national',
      jurisdictionCode: 'fixture-national',
      stateCode: 'TX',
    });

    expect(await setup.projects.get(projectId)).toMatchObject({ organizationsSelected: 1 });
  });

  it('requires a specific approval and leases one finite job once', async () => {
    const setup = await fixture({ policy: 'permitted' });
    const projectId = await setup.projects.create(projectInput());
    await setup.projects.generateDiscoveryTargets(projectId, 'owner@example.test');

    await expect(
      setup.projects.createApprovedBatch({
        projectId,
        kind: 'discovery',
        targetLimit: 1,
        approvedBy: 'owner@example.test',
        approvalNote: 'yes',
      }),
    ).rejects.toThrow(/specific release/);

    await setup.projects.createApprovedBatch({
      projectId,
      kind: 'discovery',
      targetLimit: 1,
      approvedBy: 'owner@example.test',
      approvalNote: 'Approve this one-target fixture pilot.',
    });
    const claimed = await setup.projects.claimNextJob('worker-one');
    expect(claimed?.organizationId).toBe(setup.organizationId);
    expect(await setup.projects.claimNextJob('worker-two')).toBeNull();

    await setup.projects.markJobRunning(claimed?.id ?? '', claimed?.claimToken ?? '', null);
    await setup.projects.completeJob({
      jobId: claimed?.id ?? '',
      claimToken: claimed?.claimToken ?? '',
      crawlRunId: null,
      pagesProcessed: 1,
      recordsCollected: 0,
    });
    const batches = await setup.projects.listBatches(projectId);
    expect(batches[0]).toMatchObject({ status: 'completed', completedJobs: 1 });
  });

  it('moves unreviewed sources to a policy hold without returning work', async () => {
    const setup = await fixture();
    const projectId = await setup.projects.create(projectInput());
    await setup.projects.generateDiscoveryTargets(projectId, 'owner@example.test');
    await setup.projects.createApprovedBatch({
      projectId,
      kind: 'discovery',
      targetLimit: 1,
      approvedBy: 'owner@example.test',
      approvalNote: 'Approve this one-target fixture pilot.',
    });

    expect(await setup.projects.claimNextJob('worker-one')).toBeNull();
    expect(await setup.projects.get(projectId)).toMatchObject({ policyHolds: 1 });
    expect((await setup.projects.listBatches(projectId))[0]?.status).toBe('completed_with_errors');
  });

  it('does not claim approved jobs while the project is paused', async () => {
    const setup = await fixture({ policy: 'permitted' });
    const projectId = await setup.projects.create(projectInput());
    await setup.projects.generateDiscoveryTargets(projectId, 'owner@example.test');
    await setup.projects.createApprovedBatch({
      projectId,
      kind: 'discovery',
      targetLimit: 1,
      approvedBy: 'owner@example.test',
      approvalNote: 'Approve this one-target fixture pilot.',
    });
    await setup.projects.setStatus(projectId, 'paused', 'owner@example.test');

    expect(await setup.projects.claimNextJob('worker-one')).toBeNull();
  });

  it('allows only one active job per registrable domain across workers', async () => {
    const setup = await fixture({ policy: 'permitted' });
    const second = await database?.query<{ id: string }>(
      `insert into organizations (
         organization_type_code, government_level_code, sector_code, jurisdiction_id,
         name, name_normalized, website_url, identity_tier, identity_fingerprint,
         source_document_id, extraction_method_code, confidence
       ) select
         'school','special_district','education',jurisdiction_id,
         'Second Fixture School','second fixture school','https://staff.district.example.test',
         'official_identifier','second-fixture-school',source_document_id,'manual',1
       from organizations where id = $1 returning id`,
      [setup.organizationId],
    );
    const source = await database?.query<{ source_document_id: string }>(
      'select source_document_id from organizations where id = $1',
      [setup.organizationId],
    );
    await database?.query(
      `insert into organization_locations (
         organization_id, state_code, is_primary, source_document_id,
         extraction_method_code, confidence
       ) values ($1,'TX',true,$2,'manual',1)`,
      [second?.rows[0]?.id, source?.rows[0]?.source_document_id],
    );
    const projectId = await setup.projects.create(projectInput());
    expect(await setup.projects.get(projectId)).toMatchObject({ organizationsSelected: 2 });
    await setup.projects.generateDiscoveryTargets(projectId, 'owner@example.test');
    await setup.projects.createApprovedBatch({
      projectId,
      kind: 'discovery',
      targetLimit: 2,
      approvedBy: 'owner@example.test',
      approvalNote: 'Approve these two same-domain fixture targets.',
    });

    const first = await setup.projects.claimNextJob('worker-one');
    expect(first).not.toBeNull();
    expect(await setup.projects.claimNextJob('worker-two')).toBeNull();
    await setup.projects.completeJob({
      jobId: first?.id ?? '',
      claimToken: first?.claimToken ?? '',
      crawlRunId: null,
      pagesProcessed: 1,
      recordsCollected: 0,
    });
    const next = await setup.projects.claimNextJob('worker-two');
    expect(next?.organizationId).toBe(second?.rows[0]?.id);
    await setup.projects.blockJob({
      jobId: next?.id ?? '',
      claimToken: next?.claimToken ?? '',
      outcome: 'blocked',
      reason: 'robots.txt disallowed this fixture target',
    });
    const blocked = await database?.query<{ status: string }>(
      'select status from crawl_targets where id = $1',
      [next?.crawlTargetId],
    );
    expect(blocked?.rows[0]?.status).toBe('blocked');
  });
});

function projectInput() {
  return {
    key: `test-${crypto.randomUUID()}`,
    name: 'Fixture education project',
    jurisdictionConfigKey: 'fixture-education',
    jurisdictionCode: 'fixture-education',
    stateCode: 'TX',
    sectorCodes: ['education'],
    governmentLevelCodes: ['special_district'],
    batchSize: 10,
    maxPagesPerTarget: 5,
    maxPagesPerBatch: 25,
    maxErrorsPerBatch: 2,
    createdBy: 'owner@example.test',
  };
}

async function fixture(options: { policy?: 'permitted' } = {}) {
  database = await TestDatabase.create({ sectors: [educationSectorPack] });
  const source = await database.query<{ id: string }>(
    `insert into source_documents (
       url, url_canonical, url_hash, domain, source_type_code
     ) values (
       'https://fixtures.example.test/bootstrap', 'https://fixtures.example.test/bootstrap',
       'fixture-bootstrap-hash', 'fixtures.example.test', 'html_directory'
     ) returning id`,
  );
  const jurisdiction = await database.query<{ id: string }>(
    `insert into jurisdictions (code, name, government_level_code)
     values ('fixture-education','Fixture education','special_district') returning id`,
  );
  const organization = await database.query<{ id: string }>(
    `insert into organizations (
       organization_type_code, government_level_code, sector_code, jurisdiction_id,
       name, name_normalized, website_url, identity_tier, identity_fingerprint,
       source_document_id, extraction_method_code, confidence
     ) values (
       'school','special_district','education',$1,'Fixture School','fixture school',
       'https://district.example.test','official_identifier','fixture-school',$2,'manual',1
     ) returning id`,
    [jurisdiction.rows[0]?.id, source.rows[0]?.id],
  );
  await database.query(
    `insert into organization_locations (
       organization_id, state_code, is_primary, source_document_id,
       extraction_method_code, confidence
     ) values ($1,'TX',true,$2,'manual',1)`,
    [organization.rows[0]?.id, source.rows[0]?.id],
  );
  if (options.policy === 'permitted') {
    await database.query(
      `insert into source_policies (
         domain, collection_status, commercial_use_status, solicitation_status,
         automated_access_status, reviewed_by, last_reviewed_at
       ) values ('district.example.test','permitted','unknown','unknown','permitted','owner',now())`,
    );
  }
  return {
    projects: new CollectionProjectRepository(database),
    organizationId: organization.rows[0]?.id,
  };
}
