import {
  IngestionRepository,
  OrganizationRepository,
  TestDatabase,
} from '@public-workforce/database';
import { educationSectorPack } from '@public-workforce/sector-education';
import { afterEach, describe, expect, it } from 'vitest';
import {
  planUncoveredCampusTargets,
  seedUncoveredCampusTargets,
} from './uncovered-campus-targets.js';

const OBSERVED_AT = '2026-09-11T20:00:00.000Z';
let open: TestDatabase | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

describe('Texas uncovered campus targets', () => {
  it('stays inside the checksummed domain scope and creates pending targets idempotently', async () => {
    const database = await TestDatabase.create({ sectors: [educationSectorPack] });
    open = database;
    const ingestion = new IngestionRepository(database);
    const organizations = new OrganizationRepository(database);
    const source = await ingestion.recordSourceDocument({
      url: 'https://fixture.example/approved-workbook',
      urlCanonical: 'https://fixture.example/approved-workbook',
      urlHash: 'approved-workbook',
      domain: 'fixture.example',
      sourceTypeCode: 'bulk_dataset',
      httpStatus: 200,
      contentHash: 'approved-workbook-content',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      storageKey: 'fixtures/approved-workbook.xlsx',
      robotsAllowed: null,
      robotsPolicyNote: null,
      sourcePolicyId: null,
      crawlRunId: null,
      retrievedAt: OBSERVED_AT,
    });
    const jurisdictionId = await organizations.upsertJurisdiction({
      code: 'us-tx-education-target-test',
      name: 'Texas education target test',
      governmentLevelCode: 'special_district',
    });
    const eligible = await school('Eligible School', 'https://campus.approved.example/staff');
    const covered = await school('Covered School', 'https://covered.approved.example');
    const outside = await school('Outside School', 'https://unapproved.example/staff');
    const missing = await school('Missing School', null);
    const project = (
      await database.query<{ id: string }>(
        `insert into collection_projects (
           key,name,jurisdiction_config_key,jurisdiction_id,state_code,sector_codes,
           government_level_codes,filters,batch_size,max_pages_per_target,
           max_pages_per_batch,max_errors_per_batch,created_by
         ) values ('tx-uncovered-test','TX uncovered test','texas-education',$1,'TX',
                   array['education'],array['special_district'],'{}',1000,250,100000,1000,'test')
         returning id`,
        [jurisdictionId],
      )
    ).rows[0]!.id;
    for (const organizationId of [eligible, covered, outside, missing])
      await database.query(
        `insert into collection_project_organizations(project_id,organization_id,selection_reason)
         values ($1,$2,'test')`,
        [project, organizationId],
      );

    const person = (
      await database.query<{ id: string }>(
        `insert into people(full_name_published,identity_key,source_document_id,extraction_method_code,confidence)
         values ('Published Person','covered-person',$1,'file_import',1) returning id`,
        [source.documentId],
      )
    ).rows[0]!.id;
    await database.query(
      `insert into employment_assignments(person_id,organization_id,source_document_id,extraction_method_code,confidence)
       values ($1,$2,$3,'file_import',1)`,
      [person, covered, source.documentId],
    );
    await ingestion.recordObservation({
      sourceDocumentVersionId: source.versionId,
      crawlRunId: null,
      evidenceClass: 'contact',
      entityType: 'person',
      entityId: person,
      recordKey: 'covered-person',
      field: 'legacy_artifact_id',
      valueRaw: 'fixture-artifact',
      valueNormalized: 'fixture-artifact',
      extractionMethod: 'file_import',
      confidence: 1,
      selector: null,
      observedAt: OBSERVED_AT,
    });

    const approvedDomains = new Set(['approved.example']);
    expect(
      await planUncoveredCampusTargets(database, {
        projectId: project,
        artifactId: 'fixture-artifact',
        approvedDomains,
      }),
    ).toEqual({
      artifactRowsImported: 1,
      selectedCampuses: 4,
      alreadyCovered: 1,
      missingWebsite: 1,
      outsideApprovedDomains: 1,
      invalidWebsite: 0,
      eligibleCampuses: 1,
      distinctWebsiteTargets: 1,
      existingTargetAssociations: 0,
      associationsToCreate: 1,
    });

    const first = await seedUncoveredCampusTargets(database, {
      projectId: project,
      artifactId: 'fixture-artifact',
      expectedArtifactRecords: 1,
      approvedDomains,
      actor: 'owner@example.test',
    });
    expect(first).toMatchObject({ targetRowsCreated: 1, associationsCreated: 1 });
    expect(await database.count('collection_batches')).toBe(0);
    expect(await database.count('collection_jobs')).toBe(0);
    const target = await database.query<{
      url: string;
      status: string;
      source_document_id: string;
    }>(
      `select target.url,target.status,link.source_document_id
       from crawl_targets target join crawl_target_organizations link on link.crawl_target_id=target.id`,
    );
    expect(target.rows).toEqual([
      {
        url: 'https://campus.approved.example/staff',
        status: 'pending',
        source_document_id: source.documentId,
      },
    ]);

    const second = await seedUncoveredCampusTargets(database, {
      projectId: project,
      artifactId: 'fixture-artifact',
      expectedArtifactRecords: 1,
      approvedDomains,
      actor: 'owner@example.test',
    });
    expect(second).toMatchObject({
      targetRowsCreated: 0,
      associationsCreated: 0,
      existingTargetAssociations: 1,
      associationsToCreate: 0,
    });

    await expect(
      seedUncoveredCampusTargets(database, {
        projectId: project,
        artifactId: 'another-artifact',
        expectedArtifactRecords: 1,
        approvedDomains,
        actor: 'owner@example.test',
      }),
    ).rejects.toThrow('artifact import is incomplete');

    async function school(name: string, websiteUrl: string | null): Promise<string> {
      const organization = await organizations.upsertOrganization({
        organizationTypeCode: 'school',
        governmentLevelCode: 'special_district',
        sectorCode: 'education',
        jurisdictionId,
        name,
        nameNormalized: name.toLowerCase().replaceAll(' ', '-'),
        websiteUrl,
        sourceIdentifier: { system: 'fixture', value: name },
        sourceDocumentId: source.documentId,
        extractionMethod: 'file_import',
        confidence: 1,
        observedAt: OBSERVED_AT,
      });
      return organization.id;
    }
  });

  it('refuses a project that can include another state', async () => {
    const database = await TestDatabase.create({ sectors: [educationSectorPack] });
    open = database;
    const project = (
      await database.query<{ id: string }>(
        `insert into collection_projects (
           key,name,jurisdiction_config_key,state_code,sector_codes,government_level_codes,
           filters,batch_size,max_pages_per_target,max_pages_per_batch,max_errors_per_batch,created_by
         ) values ('multi-state-test','Multi state','source-roster',null,array['education'],
                   array['special_district'],'{"stateCodes":["TX","FL"]}',10,10,100,3,'test') returning id`,
      )
    ).rows[0]!.id;
    await expect(
      planUncoveredCampusTargets(database, {
        projectId: project,
        artifactId: 'fixture-artifact',
        approvedDomains: new Set(['approved.example']),
      }),
    ).rejects.toThrow('scoped only to Texas');
  });
});
