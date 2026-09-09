import { randomUUID } from 'node:crypto';
import {
  SourcePolicyRegistry,
  canonicalizeUrl,
  domainOf,
  registrableDomain,
  urlHash,
  type WebsiteScope,
} from '@public-workforce/core';
import { US_LOCALITY_DOMAIN_LABELS } from '@public-workforce/taxonomy';
import type {
  CollectionBatchStatus,
  CollectionJobKind,
  CollectionJobStatus,
  CollectionProjectStatus,
  SourcePolicyRecord,
  Uuid,
} from '@public-workforce/shared-types';
import { runAtomically, type SqlClient } from '../client.js';
import { OrganizationSpineImportRepository } from './spine-import.js';

export interface CollectionProjectFilters {
  organizationTypeCodes: string[];
  includedOrganizationIds: Uuid[];
  excludedOrganizationIds: Uuid[];
  workMode: CollectionWorkMode;
  allGovernmentLevels?: boolean;
  stateCodes?: string[];
}

export type CollectionWorkMode = 'approved_batch_complete' | 'operator_job_limit';

export interface CreateCollectionProjectInput {
  key: string;
  name: string;
  jurisdictionConfigKey: string;
  jurisdictionCode: string;
  stateCode: string | null;
  sectorCodes: string[];
  governmentLevelCodes: string[];
  filters?: Partial<CollectionProjectFilters>;
  estimatedOrganizationCount?: number | null;
  batchSize: number;
  maxPagesPerTarget: number;
  maxPagesPerBatch: number;
  maxErrorsPerBatch: number;
  createdBy: string;
}

export interface CollectionProjectSummary {
  id: Uuid;
  key: string;
  name: string;
  jurisdictionConfigKey: string;
  jurisdictionId: Uuid | null;
  stateCode: string | null;
  sectorCodes: string[];
  governmentLevelCodes: string[];
  filters: CollectionProjectFilters;
  estimatedOrganizationCount: number | null;
  batchSize: number;
  maxPagesPerTarget: number;
  maxPagesPerBatch: number;
  maxErrorsPerBatch: number;
  status: CollectionProjectStatus;
  organizationsSelected: number;
  sourceRecordsSelected: number;
  sourceRecordsReady: number;
  sourceRecordsHeld: number;
  websitesAvailable: number;
  directoriesReady: number;
  targetsCrawled: number;
  recordsCollected: number;
  failedJobs: number;
  policyHolds: number;
  queuedJobs: number;
  runningJobs: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionBatchSummary {
  id: Uuid;
  sequenceNumber: number;
  kind: CollectionJobKind;
  status: CollectionBatchStatus;
  targetLimit: number;
  pageLimit: number;
  errorLimit: number;
  pagesProcessed: number;
  errorsEncountered: number;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalNote: string | null;
  completedJobs: number;
  failedJobs: number;
  heldJobs: number;
  queuedJobs: number;
  createdAt: string;
}

export interface CollectionPolicyHold {
  domain: string;
  targetUrl: string;
  sourceTypeCode: string;
  organizationName: string;
  reason: string;
  jobCount: number;
}

export interface CreateApprovedBatchInput {
  projectId: Uuid;
  kind: CollectionJobKind;
  targetLimit: number;
  approvedBy: string;
  approvalNote: string;
}

export interface ClaimedCollectionJob {
  id: Uuid;
  projectId: Uuid;
  batchId: Uuid;
  kind: CollectionJobKind;
  claimToken: Uuid;
  crawlTargetId: Uuid;
  url: string;
  adapterKey: string | null;
  sourceTypeCode: string;
  organizationId: Uuid;
  organizationName: string;
  parentOrganizationName: string | null;
  jurisdictionId: Uuid | null;
  governmentLevelCode: string | null;
  sectorCode: string;
  collectDiscovered?: boolean;
  discoveryState?: unknown;
  websiteScope?: WebsiteScope;
  maxPagesPerTarget: number;
  /** Preserved across an expired lease so an executor can load its checkpoint. */
  crawlRunId: Uuid | null;
}

export interface CompleteCollectionJobInput {
  jobId: Uuid;
  claimToken: Uuid;
  crawlRunId: Uuid | null;
  pagesProcessed: number;
  recordsCollected: number;
  detail?: string | null;
}

export interface FailCollectionJobInput {
  jobId: Uuid;
  claimToken: Uuid;
  error: string;
  retryable: boolean;
}

export interface BlockCollectionJobInput {
  jobId: Uuid;
  claimToken: Uuid;
  outcome: 'policy_hold' | 'blocked';
  reason: string;
}

const EMPTY_FILTERS: CollectionProjectFilters = {
  organizationTypeCodes: [],
  includedOrganizationIds: [],
  excludedOrganizationIds: [],
  workMode: 'approved_batch_complete',
};

/**
 * The operator control plane and its durable scheduler queue.
 *
 * A project defines scope. Only a finite batch carries approval, and workers
 * receive work through expiring leases so two processes cannot run one target.
 */
export class CollectionProjectRepository {
  constructor(private readonly client: SqlClient) {}

  async create(input: CreateCollectionProjectInput): Promise<Uuid> {
    validateProjectInput(input);
    const filters = normalizeFilters(input.filters);
    return runAtomically(this.client, async (tx) => {
      const jurisdiction = await tx.query<{ id: Uuid }>(
        'select id from jurisdictions where code = $1',
        [input.jurisdictionCode],
      );
      const result = await tx.query<{ id: Uuid }>(
        `insert into collection_projects (
           key, name, jurisdiction_config_key, jurisdiction_id, state_code,
           sector_codes, government_level_codes, filters, estimated_organization_count,
           batch_size, max_pages_per_target, max_pages_per_batch,
           max_errors_per_batch, created_by
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         returning id`,
        [
          input.key,
          input.name.trim(),
          input.jurisdictionConfigKey,
          jurisdiction.rows[0]?.id ?? null,
          input.stateCode,
          input.sectorCodes,
          input.governmentLevelCodes,
          JSON.stringify(filters),
          input.estimatedOrganizationCount ?? null,
          input.batchSize,
          input.maxPagesPerTarget,
          input.maxPagesPerBatch,
          input.maxErrorsPerBatch,
          input.createdBy,
        ],
      );
      const id = required(result.rows[0]?.id, 'collection_projects: insert returned no id');
      await this.refreshOrganizationsWith(tx, id);
      await appendAudit(tx, input.createdBy, 'collection_project.created', id, {
        jurisdictionConfigKey: input.jurisdictionConfigKey,
        sectorCodes: input.sectorCodes,
      });
      return id;
    });
  }

  async prepareRoster(
    input: CreateCollectionProjectInput,
    sourceKeys: readonly string[],
    stateCodes: readonly string[],
  ): Promise<Uuid> {
    if (sourceKeys.length === 0 || stateCodes.length === 0)
      throw new Error('choose source rosters and states');
    const available = await this.client.query(
      `select 1 from organization_spine_records where source_key=any($1::text[]) and location->>'stateCode'=any($2::text[]) limit 1`,
      [sourceKeys, stateCodes],
    );
    if (available.rows.length === 0)
      throw new Error(
        'No loaded source records match these states and rosters. Import the official release first.',
      );
    const importer = new OrganizationSpineImportRepository(this.client);
    while ((await importer.canonicalizeReady(2000, { sourceKeys, stateCodes })) > 0) {
      /* Each transaction is bounded and idempotent. */
    }
    for (const sourceKey of sourceKeys) await importer.materializeRelationships(sourceKey);
    const projectId = await this.create({
      ...input,
      filters: { ...input.filters, allGovernmentLevels: true, stateCodes: [...stateCodes] },
    });
    await this.client.query(
      `insert into collection_project_source_records (project_id,source_record_id,added_by)
      select $1,id,$2 from organization_spine_records where source_key=any($3::text[]) and location->>'stateCode'=any($4::text[]) on conflict do nothing`,
      [projectId, input.createdBy, sourceKeys, stateCodes],
    );
    await this.generateDiscoveryTargets(projectId, input.createdBy);
    return projectId;
  }

  async organizationOutcomes(
    projectId: Uuid,
    after: Uuid | null = null,
  ): Promise<Record<string, unknown>[]> {
    return (
      await this.client.query<Record<string, unknown>>(
        `select o.id,o.name,o.website_url,
      (select count(*)::int from employment_assignments e where e.organization_id=o.id) as people,
      (select count(*)::int from email_addresses e where e.organization_id=o.id and e.classification in ('published','decoded_published')) as published_emails,
      case when o.website_url is null then 'missing website'
        when exists(select 1 from crawl_target_organizations l join collection_jobs j on j.crawl_target_id=l.crawl_target_id where l.organization_id=o.id and j.project_id=$1 and j.status='policy_hold') then 'policy hold'
        when exists(select 1 from crawl_target_organizations l join collection_jobs j on j.crawl_target_id=l.crawl_target_id where l.organization_id=o.id and j.project_id=$1 and j.status in ('queued','claimed','running')) then 'in progress'
        when exists(select 1 from crawl_target_organizations l join collection_jobs j on j.crawl_target_id=l.crawl_target_id where l.organization_id=o.id and j.project_id=$1 and (j.status in ('failed','cancelled') or j.outcome_detail is not null)) then 'partial or exception'
        when exists(select 1 from crawl_target_organizations l join collection_jobs j on j.crawl_target_id=l.crawl_target_id where l.organization_id=o.id and j.project_id=$1 and j.kind='crawl' and j.status='completed') then 'collected'
        else 'not collected' end as outcome,
      (select coalesce(j.outcome_detail,j.last_error) from crawl_target_organizations l join collection_jobs j on j.crawl_target_id=l.crawl_target_id
       where l.organization_id=o.id and j.project_id=$1 and coalesce(j.outcome_detail,j.last_error) is not null order by j.created_at desc limit 1) as detail
      from collection_project_organizations scope join organizations o on o.id=scope.organization_id
      where scope.project_id=$1 and ($2::uuid is null or o.id>$2) order by o.id limit 100`,
        [projectId, after],
      )
    ).rows;
  }

  async domainManifest(
    projectId: Uuid,
  ): Promise<{ domain: string; url: string; status: string; reason: string }[]> {
    const rows = await this.client.query<{ url: string }>(
      `select distinct t.url from crawl_targets t
      join crawl_target_organizations l on l.crawl_target_id=t.id
      join collection_project_organizations scope on scope.organization_id=l.organization_id where scope.project_id=$1 order by t.url`,
      [projectId],
    );
    const registry = await loadSourcePolicyRegistry(this.client);
    const domains = new Map<
      string,
      { domain: string; url: string; status: string; reason: string }
    >();
    for (const row of rows.rows) {
      const domain = new URL(row.url).hostname;
      const decision = registry.evaluate(row.url, 'production');
      domains.set(row.url, {
        domain,
        url: row.url,
        status: decision.allowed ? 'ready' : decision.status,
        reason: decision.reason,
      });
    }
    return [...domains.values()];
  }

  async resumePolicyHolds(projectId: Uuid, actor: string): Promise<number> {
    return runAtomically(this.client, async (tx) => {
      const registry = await loadSourcePolicyRegistry(tx);
      const rows = await tx.query<{ id: Uuid; url: string; batch_id: Uuid }>(
        `select j.id,t.url,j.batch_id from collection_jobs j
        join collection_batches b on b.id=j.batch_id join crawl_targets t on t.id=j.crawl_target_id
        where j.project_id=$1 and j.status='policy_hold' and b.collect_discovered and b.expires_at>now()
          and b.status<>'cancelled' and b.pages_processed<b.page_limit and b.errors_encountered<b.error_limit for update of j`,
        [projectId],
      );
      let count = 0;
      for (const row of rows.rows)
        if (registry.evaluate(row.url, 'production').allowed) {
          await tx.query(
            `update collection_jobs set status='queued',finished_at=null,last_error=null where id=$1`,
            [row.id],
          );
          await tx.query(
            `update collection_batches set status='queued',finished_at=null where id=$1`,
            [row.batch_id],
          );
          count++;
        }
      await appendAudit(tx, actor, 'collection_run.policy_holds_resumed', projectId, { count });
      return count;
    });
  }

  async list(): Promise<CollectionProjectSummary[]> {
    const result = await this.client.query<Record<string, unknown>>(PROJECT_SUMMARY_SQL);
    return result.rows.map(mapProject);
  }

  async get(projectId: Uuid): Promise<CollectionProjectSummary | null> {
    const result = await this.client.query<Record<string, unknown>>(
      `${PROJECT_SUMMARY_SQL} where p.id = $1`,
      [projectId],
    );
    return result.rows[0] === undefined ? null : mapProject(result.rows[0]);
  }

  async listBatches(projectId: Uuid): Promise<CollectionBatchSummary[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `select b.*,
              count(j.id) filter (where j.status = 'completed')::int as completed_jobs,
              count(j.id) filter (where j.status = 'failed')::int as failed_jobs,
              count(j.id) filter (where j.status = 'policy_hold')::int as held_jobs,
              count(j.id) filter (where j.status in ('queued','claimed','running'))::int as queued_jobs
       from collection_batches b
       left join collection_jobs j on j.batch_id = b.id
       where b.project_id = $1
       group by b.id order by b.sequence_number desc`,
      [projectId],
    );
    return result.rows.map(mapBatch);
  }

  /** Lists actionable held domains without weakening the policy gate. */
  async listPolicyHolds(projectId: Uuid): Promise<CollectionPolicyHold[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `select j.domain_key,
              min(t.url) as target_url,
              min(t.source_type_code) as source_type_code,
              min(o.name) as organization_name,
              min(j.last_error) as reason,
              count(*)::int as job_count
       from collection_jobs j
       join crawl_targets t on t.id = j.crawl_target_id
       join organizations o on o.id = t.organization_id
       where j.project_id = $1 and j.status = 'policy_hold'
       group by j.domain_key
       order by j.domain_key`,
      [projectId],
    );
    return result.rows.map((row) => ({
      domain: String(row['domain_key']),
      targetUrl: String(row['target_url']),
      sourceTypeCode: String(row['source_type_code']),
      organizationName: String(row['organization_name']),
      reason: String(row['reason']),
      jobCount: Number(row['job_count']),
    }));
  }

  /** Refreshes the materialized scope without removing anything already released. */
  async refreshOrganizations(projectId: Uuid): Promise<number> {
    return runAtomically(this.client, (tx) => this.refreshOrganizationsWith(tx, projectId));
  }

  private async refreshOrganizationsWith(tx: SqlClient, projectId: Uuid): Promise<number> {
    const project = await tx.query<Record<string, unknown>>(
      `select jurisdiction_id, state_code, sector_codes, government_level_codes, filters
       from collection_projects where id = $1 for update`,
      [projectId],
    );
    const row = project.rows[0];
    if (row === undefined) throw new Error('collection project not found');
    const filters = parseFilters(row['filters']);
    const inserted = await tx.query<{ organization_id: Uuid }>(
      `insert into collection_project_organizations (project_id, organization_id, selection_reason)
       select $1, o.id, 'project scope'
       from organizations o
       where (($2::uuid is null or o.jurisdiction_id = $2
               or ($8::text is not null and exists (
                 select 1 from organization_locations location
                 where location.organization_id = o.id and location.state_code = $8
               )))
              or (cardinality($6::uuid[]) > 0 and o.id = any($6::uuid[])))
         and o.sector_code = any($3::text[])
         and (o.government_level_code = any($4::text[]) or $9::boolean)
         and ($8::text is null or exists (
           select 1 from organization_locations location
           where location.organization_id = o.id and location.state_code = $8
         ))
         and (cardinality($10::text[])=0 or exists(select 1 from organization_locations l where l.organization_id=o.id and l.state_code=any($10::text[])))
         and (cardinality($5::text[]) = 0 or o.organization_type_code = any($5::text[]))
         and (cardinality($6::uuid[]) = 0 or o.id = any($6::uuid[]))
         and not (o.id = any($7::uuid[]))
       on conflict do nothing
       returning organization_id`,
      [
        projectId,
        row['jurisdiction_id'] ?? null,
        stringArray(row['sector_codes']),
        stringArray(row['government_level_codes']),
        filters.organizationTypeCodes,
        filters.includedOrganizationIds,
        filters.excludedOrganizationIds,
        row['state_code'] ?? null,
        filters.allGovernmentLevels === true,
        filters.stateCodes ?? [],
      ],
    );
    return inserted.rows.length;
  }

  /** Turns published organization website URLs into reviewable discovery targets. */
  async generateDiscoveryTargets(projectId: Uuid, actor: string): Promise<number> {
    return runAtomically(this.client, async (tx) => {
      const candidates = await tx.query<{
        organization_id: Uuid;
        jurisdiction_id: Uuid | null;
        website_url: string;
      }>(
        `select o.id as organization_id, o.jurisdiction_id, o.website_url
         from collection_project_organizations po
         join organizations o on o.id = po.organization_id
         where po.project_id = $1 and o.website_url is not null`,
        [projectId],
      );
      let created = 0;
      const records = candidates.rows.flatMap((candidate) => {
        const url = canonicalizeUrl(candidate.website_url);
        return url === null
          ? []
          : [
              {
                organizationId: candidate.organization_id,
                jurisdictionId: candidate.jurisdiction_id,
                url,
                hash: urlHash(url),
              },
            ];
      });
      for (let offset = 0; offset < records.length; offset += 1000) {
        const chunk = JSON.stringify(records.slice(offset, offset + 1000));
        await tx.query(
          `insert into crawl_targets(organization_id,jurisdiction_id,url,url_hash,target_type,source_type_code,status,priority)
          select distinct on (r.hash) r."organizationId",r."jurisdictionId",r.url,r.hash,'organization_site','html_directory','pending',100
          from jsonb_to_recordset($1::jsonb) as r("organizationId" uuid,"jurisdictionId" uuid,url text,hash text)
          order by r.hash,r."organizationId" on conflict(url_hash) do nothing`,
          [chunk],
        );
        const linked = await tx.query(
          `insert into crawl_target_organizations(crawl_target_id,organization_id,source_document_id)
          select t.id,o.id,o.source_document_id from jsonb_to_recordset($1::jsonb) as r("organizationId" uuid,hash text)
          join crawl_targets t on t.url_hash=r.hash join organizations o on o.id=r."organizationId"
          on conflict do nothing returning crawl_target_id`,
          [chunk],
        );
        created += linked.rows.length;
      }
      await appendAudit(tx, actor, 'collection_project.discovery_targets_generated', projectId, {
        created,
        publishedWebsites: candidates.rows.length,
      });
      return created;
    });
  }

  /** Snapshots the complete prepared scope under one finite human authorization. */
  async createApprovedRun(input: {
    projectId: Uuid;
    approvedBy: string;
    approvalNote: string;
    expiresAt: string;
  }): Promise<Uuid> {
    if (input.approvedBy.trim().length === 0 || input.approvalNote.trim().length < 8)
      throw new Error('named approval and a specific run note are required');
    const expiry = new Date(input.expiresAt).getTime();
    if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 31 * 86400000)
      throw new Error('run expiry must be within the next 31 days');
    return runAtomically(this.client, async (tx) => {
      const config = (
        await tx.query<Record<string, unknown>>(
          'select * from collection_projects where id=$1 for update',
          [input.projectId],
        )
      ).rows[0];
      if (config === undefined || ['cancelled', 'completed'].includes(String(config['status'])))
        throw new Error('project is not available');
      const batch = (
        await tx.query<{ id: Uuid }>(
          `insert into collection_batches (project_id,sequence_number,kind,status,target_limit,page_limit,error_limit,approved_by,approved_at,approval_note,created_by,collect_discovered,expires_at)
         select $1,coalesce(max(sequence_number),0)+1,'discovery','queued',1000000,$2,$3,$4,now(),$5,$4,true,$6
         from collection_batches where project_id=$1 returning id`,
          [
            input.projectId,
            config['max_pages_per_batch'],
            config['max_errors_per_batch'],
            input.approvedBy,
            input.approvalNote,
            input.expiresAt,
          ],
        )
      ).rows[0];
      if (batch === undefined) throw new Error('run insert returned no id');
      await tx.query(
        `insert into collection_batch_organizations select $1,organization_id from collection_project_organizations where project_id=$2`,
        [batch.id, input.projectId],
      );
      const targets = await tx.query<{ id: Uuid; url: string; target_type: string }>(
        `select distinct t.id,t.url,t.target_type from crawl_targets t
         join crawl_target_organizations links on links.crawl_target_id=t.id
         join collection_batch_organizations scope on scope.organization_id=links.organization_id and scope.batch_id=$1
         where t.status not in ('blocked','excluded') and not exists (
           select 1 from collection_jobs j where j.crawl_target_id=t.id and j.status in ('queued','claimed','running'))`,
        [batch.id],
      );
      if (targets.rows.length === 0)
        throw new Error('no published websites are ready; prepare the roster first');
      for (let offset = 0; offset < targets.rows.length; offset += 1000) {
        const chunk = targets.rows.slice(offset, offset + 1000).map((target) => ({
          id: target.id,
          domain: registrableDomain(new URL(target.url).hostname, US_LOCALITY_DOMAIN_LABELS),
          kind: target.target_type === 'organization_site' ? 'discovery' : 'crawl',
        }));
        await tx.query(
          `insert into collection_jobs(project_id,batch_id,crawl_target_id,domain_key,kind)
          select $1,$2,r.id,r.domain,r.kind::collection_job_kind from jsonb_to_recordset($3::jsonb) as r(id uuid,domain text,kind text)`,
          [input.projectId, batch.id, JSON.stringify(chunk)],
        );
      }
      await tx.query(
        `update collection_projects set status='active',updated_at=now() where id=$1`,
        [input.projectId],
      );
      await appendAudit(tx, input.approvedBy, 'collection_run.approved', batch.id, {
        projectId: input.projectId,
        initialTargets: targets.rows.length,
        expiresAt: input.expiresAt,
        approvalNote: input.approvalNote,
      });
      return batch.id;
    });
  }

  async renewLease(jobId: Uuid, claimToken: Uuid, seconds = 300): Promise<void> {
    const result = await this.client.query<{ id: Uuid }>(
      `update collection_jobs j set lease_expires_at=now()+make_interval(secs=>$3)
       from collection_projects p,collection_batches b
       where j.id=$1 and j.claim_token=$2 and j.status in ('claimed','running') and j.lease_expires_at>now()
         and p.id=j.project_id and p.status='active' and b.id=j.batch_id
         and b.status in ('queued','running') and (b.expires_at is null or b.expires_at>now()) returning j.id`,
      [jobId, claimToken, seconds],
    );
    if (result.rows.length === 0)
      throw new Error('collection lease expired, cancelled, paused, or superseded');
  }

  async saveDiscoveryState(jobId: Uuid, claimToken: Uuid, state: unknown): Promise<void> {
    await this.renewLease(jobId, claimToken);
    await this.client.query(
      'update collection_jobs set discovery_state=$3 where id=$1 and claim_token=$2',
      [jobId, claimToken, JSON.stringify(state)],
    );
  }

  /** Charge before transport, including retries; independent workers share this counter. */
  async reserveRequest(jobId: Uuid, claimToken: Uuid): Promise<void> {
    await runAtomically(this.client, async (tx) => {
      const job = (
        await tx.query<{
          batch_id: Uuid;
          collect_discovered: boolean;
          pages_processed: number;
          max_pages_per_target: number;
        }>(
          `select j.batch_id,b.collect_discovered,j.pages_processed,p.max_pages_per_target from collection_jobs j
         join collection_batches b on b.id=j.batch_id join collection_projects p on p.id=j.project_id
         where j.id=$1 and j.claim_token=$2 and j.status='running' and j.lease_expires_at>now()
           and p.status='active' and b.status in ('queued','running') and (b.expires_at is null or b.expires_at>now())
         for update of b,j`,
          [jobId, claimToken],
        )
      ).rows[0];
      if (job === undefined) throw new Error('collection claim is no longer active');
      if (!job.collect_discovered) return;
      if (Number(job.pages_processed) >= Number(job.max_pages_per_target))
        throw new Error('target request budget reached; collection is partial');
      const reserved = await tx.query(
        `update collection_batches set pages_processed=pages_processed+1
        where id=$1 and pages_processed<page_limit and errors_encountered<error_limit returning id`,
        [job.batch_id],
      );
      if (reserved.rows.length === 0)
        throw new Error('run request or error budget reached; collection is partial');
      await tx.query('update collection_jobs set pages_processed=pages_processed+1 where id=$1', [
        jobId,
      ]);
    });
  }

  async batchHasPendingWork(batchId: Uuid): Promise<boolean> {
    const result = await this.client.query(
      `select 1 from collection_jobs j join collection_projects p on p.id=j.project_id
      join collection_batches b on b.id=j.batch_id where j.batch_id=$1 and j.status in ('queued','claimed','running')
      and p.status='active' and b.status in ('queued','running') and (b.expires_at is null or b.expires_at>now())
      and b.pages_processed<b.page_limit and b.errors_encountered<b.error_limit limit 1`,
      [batchId],
    );
    return result.rows.length > 0;
  }

  async createApprovedBatch(input: CreateApprovedBatchInput): Promise<Uuid> {
    if (input.targetLimit < 1 || input.targetLimit > 1000) {
      throw new Error('target limit must be between 1 and 1000');
    }
    if (input.approvalNote.trim().length < 8) {
      throw new Error('approval note must describe this specific release');
    }
    return runAtomically(this.client, async (tx) => {
      const project = await tx.query<{
        batch_size: number;
        max_pages_per_batch: number;
        max_errors_per_batch: number;
        status: CollectionProjectStatus;
      }>('select * from collection_projects where id = $1 for update', [input.projectId]);
      const config = project.rows[0];
      if (config === undefined) throw new Error('collection project not found');
      if (config.status === 'completed' || config.status === 'cancelled') {
        throw new Error(`cannot release work for a ${config.status} project`);
      }
      const sequence = await tx.query<{ next_sequence: number }>(
        `select coalesce(max(sequence_number),0)::int + 1 as next_sequence
         from collection_batches where project_id = $1`,
        [input.projectId],
      );
      const targetLimit = Math.min(input.targetLimit, Number(config.batch_size));
      const batch = await tx.query<{ id: Uuid }>(
        `insert into collection_batches (
           project_id, sequence_number, kind, status, target_limit, page_limit,
           error_limit, approved_by, approved_at, approval_note, created_by
         ) values ($1,$2,$3,'queued',$4,$5,$6,$7,now(),$8,$7) returning id`,
        [
          input.projectId,
          sequence.rows[0]?.next_sequence ?? 1,
          input.kind,
          targetLimit,
          config.max_pages_per_batch,
          config.max_errors_per_batch,
          input.approvedBy,
          input.approvalNote.trim(),
        ],
      );
      const batchId = required(batch.rows[0]?.id, 'collection_batches: insert returned no id');
      const targetClause =
        input.kind === 'discovery'
          ? "t.target_type = 'organization_site' and t.status in ('pending','failed','policy_hold')"
          : "t.target_type in ('organization_directory','unit_directory','profile_page','api_endpoint') and t.status in ('ready','failed','policy_hold')";
      const candidates = await tx.query<{ id: Uuid; url: string; priority: number }>(
        `select t.id, t.url, t.priority
         from crawl_targets t
         join collection_project_organizations po
           on po.organization_id = t.organization_id and po.project_id = $1
         where ${targetClause}
           and not exists (
             select 1 from collection_jobs existing
             where existing.crawl_target_id = t.id
               and existing.status in ('queued','claimed','running')
           )
         order by t.priority, t.created_at
         limit $2`,
        [input.projectId, targetLimit],
      );
      if (candidates.rows.length === 0) {
        throw new Error(
          input.kind === 'discovery'
            ? 'no discovery targets are ready; refresh organizations and generate targets first'
            : 'no discovered directory targets are ready for collection',
        );
      }
      for (const candidate of candidates.rows) {
        const host = domainOf(candidate.url);
        if (host === null) throw new Error(`crawl target has an unusable url: ${candidate.url}`);
        await tx.query(
          `insert into collection_jobs (
             project_id, batch_id, crawl_target_id, domain_key, kind, status, priority
           ) values ($1,$2,$3,$4,$5,'queued',$6)`,
          [
            input.projectId,
            batchId,
            candidate.id,
            registrableDomain(host, US_LOCALITY_DOMAIN_LABELS),
            input.kind,
            candidate.priority,
          ],
        );
      }
      await tx.query(
        `update collection_projects set status = 'active', updated_at = now() where id = $1`,
        [input.projectId],
      );
      await appendAudit(tx, input.approvedBy, 'collection_batch.approved', batchId, {
        projectId: input.projectId,
        kind: input.kind,
        targetsReleased: candidates.rows.length,
        approvalNote: input.approvalNote.trim(),
      });
      return batchId;
    });
  }

  async setStatus(
    projectId: Uuid,
    status: Extract<CollectionProjectStatus, 'active' | 'paused' | 'completed' | 'cancelled'>,
    actor: string,
  ): Promise<void> {
    await runAtomically(this.client, async (tx) => {
      const changed = await tx.query<{ id: Uuid }>(
        `update collection_projects set status = $2, updated_at = now()
         where id = $1 and status not in ('completed','cancelled') returning id`,
        [projectId, status],
      );
      if (changed.rows.length === 0) throw new Error('project cannot make that transition');
      if (status === 'cancelled') {
        await tx.query(
          `update collection_jobs set status = 'cancelled', finished_at = now()
           where project_id = $1 and status in ('queued','claimed')`,
          [projectId],
        );
        await tx.query(
          `update collection_batches set status = 'cancelled', finished_at = now()
           where project_id = $1 and status in ('awaiting_approval','queued','running')`,
          [projectId],
        );
      }
      await appendAudit(tx, actor, `collection_project.${status}`, projectId, {});
    });
  }

  /**
   * Claims one eligible job with a database lease.
   *
   * Policy is evaluated inside the claim transaction. A held job is recorded
   * and skipped; it can only be released by a later, explicit batch after the
   * source policy has been reviewed.
   */
  async claimNextJob(
    workerId: string,
    leaseSeconds = 300,
    batchId: Uuid | null = null,
  ): Promise<ClaimedCollectionJob | null> {
    if (leaseSeconds < 30 || leaseSeconds > 3600) {
      throw new Error('lease must be between 30 and 3600 seconds');
    }
    return runAtomically(this.client, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext('collection_job_claim'))");
      await recoverExpiredLeases(tx);
      await tx.query(`update collection_batches b set status='completed_with_errors',finished_at=now()
        where b.expires_at<=now() and b.status in ('queued','running')
          and not exists(select 1 from collection_jobs j where j.batch_id=b.id and j.status in ('claimed','running'))`);
      await tx.query(`update collection_jobs j set status='cancelled',finished_at=now(),last_error='run expired'
        from collection_batches b where b.id=j.batch_id and b.expires_at<=now() and j.status='queued'`);
      for (;;) {
        const selected = await tx.query<Record<string, unknown>>(
          `select j.id, j.project_id, j.batch_id, j.kind, j.crawl_target_id, j.crawl_run_id,
                  t.url, t.adapter_key, t.source_type_code,
                  o.id as organization_id, o.name as organization_name, o.website_url,
                  o.jurisdiction_id, o.government_level_code, o.sector_code,
                  p.max_pages_per_target,b.collect_discovered,j.discovery_state,
                  (select parent.name
                   from organization_relationships r
                   join relationship_types rt on rt.code = r.relationship_type_code
                   join organizations parent on parent.id = r.parent_organization_id
                   where r.child_organization_id = o.id and r.effective_to is null
                     and rt.implies_subtree
                   order by r.effective_from desc limit 1) as parent_organization_name
           from collection_jobs j
           join collection_batches b on b.id = j.batch_id
           join collection_projects p on p.id = j.project_id
           join crawl_targets t on t.id = j.crawl_target_id
           join organizations o on o.id = coalesce((select links.organization_id from crawl_target_organizations links
             join collection_batch_organizations scope on scope.organization_id=links.organization_id and scope.batch_id=j.batch_id
             where links.crawl_target_id=t.id order by links.organization_id limit 1),t.organization_id)
           where j.status = 'queued' and p.status = 'active'
             and ($1::uuid is null or j.batch_id = $1)
             and b.status in ('queued','running')
             and (b.expires_at is null or b.expires_at>now())
             and b.approved_by is not null and b.approved_at is not null
             and b.pages_processed < b.page_limit
             and b.errors_encountered < b.error_limit
             and not exists (
               select 1 from collection_jobs active_domain
               where active_domain.domain_key = j.domain_key
                 and active_domain.status in ('claimed','running')
             )
           order by j.priority, j.created_at
           for update of j skip locked limit 1`,
          [batchId],
        );
        const row = selected.rows[0];
        if (row === undefined) return null;

        const decision = await evaluatePolicy(tx, String(row['url']));
        if (!decision.allowed) {
          await tx.query(
            `update collection_jobs
             set status = 'policy_hold', last_error = $2, finished_at = now()
             where id = $1`,
            [row['id'], decision.reason],
          );
          await tx.query(
            `update crawl_targets set status = 'policy_hold', exclusion_reason = $2,
                    updated_at = now() where id = $1`,
            [row['crawl_target_id'], decision.reason],
          );
          await finishBatchIfSettled(tx, String(row['batch_id']));
          continue;
        }

        const claimToken = randomUUID();
        const claimed = await tx.query<{ id: Uuid }>(
          `update collection_jobs
           set status = 'claimed', claimed_by = $2, claim_token = $3,
               lease_expires_at = now() + make_interval(secs => $4),
               attempt_count = attempt_count + 1,
               started_at = coalesce(started_at, now())
           where id = $1 and status = 'queued' returning id`,
          [row['id'], workerId, claimToken, leaseSeconds],
        );
        if (claimed.rows.length === 0) continue;
        await tx.query(
          `update collection_batches set status = 'running', started_at = coalesce(started_at, now())
           where id = $1`,
          [row['batch_id']],
        );
        await tx.query(`update crawl_targets set status = $2, updated_at = now() where id = $1`, [
          row['crawl_target_id'],
          row['kind'] === 'discovery' ? 'discovering' : 'crawling',
        ]);
        const websiteUrl = nullableString(row['website_url']);
        const websiteScope =
          websiteUrl === null
            ? undefined
            : await this.websiteScope(tx, websiteUrl, String(row['organization_id']));
        return {
          ...(websiteScope === undefined ? {} : { websiteScope }),
          id: String(row['id']),
          projectId: String(row['project_id']),
          batchId: String(row['batch_id']),
          kind: String(row['kind']) as CollectionJobKind,
          claimToken,
          crawlTargetId: String(row['crawl_target_id']),
          url: String(row['url']),
          adapterKey: nullableString(row['adapter_key']),
          sourceTypeCode: String(row['source_type_code']),
          organizationId: String(row['organization_id']),
          organizationName: String(row['organization_name']),
          parentOrganizationName: nullableString(row['parent_organization_name']),
          jurisdictionId: nullableString(row['jurisdiction_id']),
          governmentLevelCode: nullableString(row['government_level_code']),
          collectDiscovered: row['collect_discovered'] === true,
          discoveryState: row['discovery_state'],
          sectorCode: String(row['sector_code']),
          maxPagesPerTarget: Number(row['max_pages_per_target']),
          crawlRunId: nullableString(row['crawl_run_id']),
        };
      }
    });
  }

  private async websiteScope(
    tx: SqlClient,
    websiteUrl: string,
    organizationId: Uuid,
  ): Promise<WebsiteScope> {
    const host = new URL(websiteUrl).host.toLowerCase().replace(/^www\./, '');
    const other = await tx.query<{ website_url: string }>(
      `select distinct website_url from organizations where id<>$1 and website_url is not null
       and lower(split_part(split_part(split_part(website_url,'://',2),'/',1),'?',1))=any($2::text[])`,
      [organizationId, [host, 'www.' + host]],
    );
    return { websiteUrl, otherWebsiteUrls: other.rows.map((row) => row.website_url) };
  }

  async markJobRunning(jobId: Uuid, claimToken: Uuid, crawlRunId: Uuid | null): Promise<void> {
    const result = await this.client.query<{ id: Uuid }>(
      `update collection_jobs set status = 'running', crawl_run_id = $3
       where id = $1 and claim_token = $2 and status = 'claimed'
         and lease_expires_at > now() returning id`,
      [jobId, claimToken, crawlRunId],
    );
    if (result.rows.length === 0) throw new Error('collection job lease is no longer valid');
  }

  async attachCrawlRun(jobId: Uuid, claimToken: Uuid, crawlRunId: Uuid): Promise<void> {
    const result = await this.client.query<{ id: Uuid }>(
      `update collection_jobs set crawl_run_id = $3
       where id = $1 and claim_token = $2 and status = 'running'
         and lease_expires_at > now() returning id`,
      [jobId, claimToken, crawlRunId],
    );
    if (result.rows.length === 0) throw new Error('collection job lease is no longer valid');
  }

  async completeJob(input: CompleteCollectionJobInput): Promise<void> {
    await runAtomically(this.client, async (tx) => {
      const result = await tx.query<{
        batch_id: Uuid;
        crawl_target_id: Uuid;
        kind: CollectionJobKind;
      }>(
        `update collection_jobs
         set status = 'completed', crawl_run_id = coalesce($3, crawl_run_id),
             pages_processed = $4, records_collected = $5, finished_at = now(),
             lease_expires_at = null, outcome_detail=$6
         where id = $1 and claim_token = $2 and status in ('claimed','running') and lease_expires_at>now()
         returning batch_id, crawl_target_id, kind`,
        [
          input.jobId,
          input.claimToken,
          input.crawlRunId,
          input.pagesProcessed,
          input.recordsCollected,
          input.detail ?? null,
        ],
      );
      const job = result.rows[0];
      if (job === undefined) throw new Error('collection job claim does not match');
      await tx.query(
        `update crawl_targets set status = $2::crawl_target_status,
                last_crawled_at = case when $2::text = 'crawled' then now() else last_crawled_at end,
                updated_at = now() where id = $1`,
        [job.crawl_target_id, job.kind === 'discovery' ? 'ready' : 'crawled'],
      );
      await tx.query(
        `update collection_batches
         set pages_processed = pages_processed + $2
         where id = $1 and not collect_discovered`,
        [job.batch_id, input.pagesProcessed],
      );
      await enqueueDiscovered(tx, job.batch_id, job.crawl_target_id);
      await enforceBatchLimits(tx, job.batch_id);
      await finishBatchIfSettled(tx, job.batch_id);
    });
  }

  async failJob(input: FailCollectionJobInput): Promise<void> {
    await runAtomically(this.client, async (tx) => {
      const result = await tx.query<{
        batch_id: Uuid;
        crawl_target_id: Uuid;
        attempt_count: number;
        max_attempts: number;
      }>(
        `select batch_id, crawl_target_id, attempt_count, max_attempts
         from collection_jobs
         where id = $1 and claim_token = $2 and status in ('claimed','running')
         for update`,
        [input.jobId, input.claimToken],
      );
      const job = result.rows[0];
      if (job === undefined) throw new Error('collection job claim does not match');
      const retry = input.retryable && Number(job.attempt_count) < Number(job.max_attempts);
      await tx.query(
        `update collection_jobs
         set status = $3::collection_job_status, last_error = $4,
             finished_at = case when $3::collection_job_status = 'failed' then now() else null end,
             claimed_by = null, claim_token = null, lease_expires_at = null
         where id = $1 and claim_token = $2`,
        [input.jobId, input.claimToken, retry ? 'queued' : 'failed', input.error.slice(0, 2000)],
      );
      await tx.query(
        `update crawl_targets set status = $2, exclusion_reason = $3, updated_at = now()
         where id = $1`,
        [job.crawl_target_id, retry ? 'ready' : 'failed', input.error.slice(0, 2000)],
      );
      await tx.query(
        `update collection_batches set errors_encountered = errors_encountered + 1 where id = $1`,
        [job.batch_id],
      );
      await enqueueDiscovered(tx, job.batch_id, job.crawl_target_id);
      await enforceBatchLimits(tx, job.batch_id);
      await finishBatchIfSettled(tx, job.batch_id);
    });
  }

  async blockJob(input: BlockCollectionJobInput): Promise<void> {
    await runAtomically(this.client, async (tx) => {
      const result = await tx.query<{ batch_id: Uuid; crawl_target_id: Uuid }>(
        `update collection_jobs
         set status = $3, last_error = $4, finished_at = now(),
             claimed_by = null, claim_token = null, lease_expires_at = null
         where id = $1 and claim_token = $2 and status in ('claimed','running')
         returning batch_id, crawl_target_id`,
        [
          input.jobId,
          input.claimToken,
          input.outcome === 'policy_hold' ? 'policy_hold' : 'failed',
          input.reason.slice(0, 2000),
        ],
      );
      const job = result.rows[0];
      if (job === undefined) throw new Error('collection job claim does not match');
      await tx.query(
        `update crawl_targets set status = $2, exclusion_reason = $3, updated_at = now()
         where id = $1`,
        [job.crawl_target_id, input.outcome, input.reason.slice(0, 2000)],
      );
      await finishBatchIfSettled(tx, job.batch_id);
    });
  }
}

const PROJECT_SUMMARY_SQL = `
select p.*,
       (select count(*)::int from collection_project_organizations po
        where po.project_id = p.id) as organizations_selected,
       (select count(*)::int from collection_project_source_records ps
        where ps.project_id = p.id) as source_records_selected,
       (select count(*)::int from collection_project_source_records ps
        join organization_spine_records r on r.id = ps.source_record_id
        where ps.project_id = p.id and r.organization_id is not null) as source_records_ready,
       (select count(*)::int from collection_project_source_records ps
        join organization_spine_records r on r.id = ps.source_record_id
        where ps.project_id = p.id and r.organization_id is null) as source_records_held,
       (select count(*)::int from collection_project_organizations po
        join organizations o on o.id = po.organization_id
        where po.project_id = p.id and o.website_url is not null) as websites_available,
       (select count(*)::int from collection_project_organizations po
        join crawl_targets t on t.organization_id = po.organization_id
        where po.project_id = p.id and t.status = 'ready') as directories_ready,
       (select count(*)::int from collection_project_organizations po
        join crawl_targets t on t.organization_id = po.organization_id
        where po.project_id = p.id and t.status = 'crawled') as targets_crawled,
       (select coalesce(sum(j.records_collected),0)::int from collection_jobs j
        where j.project_id = p.id) as records_collected,
       (select count(*)::int from collection_jobs j
        where j.project_id = p.id and j.status = 'failed') as failed_jobs,
       (select count(*)::int from collection_jobs j
        where j.project_id = p.id and j.status = 'policy_hold') as policy_holds,
       (select count(*)::int from collection_jobs j
        where j.project_id = p.id and j.status = 'queued') as queued_jobs,
       (select count(*)::int from collection_jobs j
        where j.project_id = p.id and j.status in ('claimed','running')) as running_jobs
from collection_projects p`;

async function enqueueDiscovered(
  tx: SqlClient,
  batchId: Uuid,
  sourceTargetId: Uuid,
): Promise<void> {
  const batch = (
    await tx.query<{ project_id: Uuid }>(
      `select project_id from collection_batches where id=$1 and collect_discovered
    and expires_at>now() and status in ('queued','running') for update`,
      [batchId],
    )
  ).rows[0];
  if (batch === undefined) return;
  const targets = await tx.query<{ id: Uuid; url: string; priority: number }>(
    `select distinct t.id,t.url,t.priority from crawl_targets t join crawl_target_organizations links on links.crawl_target_id=t.id
     join collection_batch_organizations scope on scope.organization_id=links.organization_id and scope.batch_id=$1
     where links.organization_id in (select organization_id from crawl_target_organizations where crawl_target_id=$2)
       and t.target_type in ('organization_directory','unit_directory','profile_page','api_endpoint') and t.status in ('ready','crawled')
       and not exists(select 1 from collection_jobs j where j.batch_id=$1 and j.crawl_target_id=t.id and j.kind='crawl')
       and not exists(select 1 from collection_jobs j where j.crawl_target_id=t.id and j.status in ('claimed','running'))`,
    [batchId, sourceTargetId],
  );
  for (const target of targets.rows)
    await tx.query(
      `insert into collection_jobs (project_id,batch_id,crawl_target_id,domain_key,kind,priority) values ($1,$2,$3,$4,'crawl',$5) on conflict do nothing`,
      [
        batch.project_id,
        batchId,
        target.id,
        registrableDomain(new URL(target.url).hostname, US_LOCALITY_DOMAIN_LABELS),
        target.priority,
      ],
    );
}

async function recoverExpiredLeases(tx: SqlClient): Promise<void> {
  await tx.query(
    `update collection_jobs
     set status = case when attempt_count < max_attempts then 'queued'::collection_job_status
                       else 'failed'::collection_job_status end,
         last_error = 'worker lease expired before completion',
         claimed_by = null, claim_token = null, lease_expires_at = null,
         finished_at = case when attempt_count >= max_attempts then now() else null end
     where status in ('claimed','running') and lease_expires_at <= now()`,
  );
}

async function evaluatePolicy(
  tx: SqlClient,
  url: string,
): Promise<ReturnType<SourcePolicyRegistry['evaluate']>> {
  const registry = await loadSourcePolicyRegistry(tx);
  return registry.evaluate(url, 'production');
}

export async function loadSourcePolicyRegistry(client: SqlClient): Promise<SourcePolicyRegistry> {
  const policies = await client.query<Record<string, unknown>>(
    'select * from source_policies order by effective_at desc',
  );
  return new SourcePolicyRegistry(policies.rows.map(mapSourcePolicy), {
    localityDomainLabels: US_LOCALITY_DOMAIN_LABELS,
  });
}

function mapSourcePolicy(row: Record<string, unknown>): SourcePolicyRecord {
  return {
    id: String(row['id']),
    domain: nullableString(row['domain']),
    urlPattern: nullableString(row['url_pattern']),
    organizationId: nullableString(row['organization_id']),
    jurisdictionId: nullableString(row['jurisdiction_id']),
    sourceTypeCode: nullableString(row['source_type_code']),
    collectionStatus: String(row['collection_status']) as SourcePolicyRecord['collectionStatus'],
    commercialUseStatus: String(
      row['commercial_use_status'],
    ) as SourcePolicyRecord['commercialUseStatus'],
    solicitationStatus: String(
      row['solicitation_status'],
    ) as SourcePolicyRecord['solicitationStatus'],
    automatedAccessStatus: String(
      row['automated_access_status'],
    ) as SourcePolicyRecord['automatedAccessStatus'],
    policyUrl: nullableString(row['policy_url']),
    policyTextSnapshot: nullableString(row['policy_text_snapshot']),
    policyTextHash: nullableString(row['policy_text_hash']),
    effectiveAt: iso(row['effective_at']),
    lastReviewedAt: nullableIso(row['last_reviewed_at']),
    reviewedBy: nullableString(row['reviewed_by']),
    reviewNotes: nullableString(row['review_notes']),
    productionApprovedBy: nullableString(row['production_approved_by']),
    productionApprovedAt: nullableIso(row['production_approved_at']),
    productionApprovalNote: nullableString(row['production_approval_note']),
    createdAt: iso(row['created_at']),
  };
}

async function enforceBatchLimits(tx: SqlClient, batchId: Uuid): Promise<void> {
  const batch = await tx.query<{
    pages_processed: number;
    page_limit: number;
    errors_encountered: number;
    error_limit: number;
  }>('select * from collection_batches where id = $1 for update', [batchId]);
  const row = batch.rows[0];
  if (row === undefined) return;
  if (
    Number(row.pages_processed) < Number(row.page_limit) &&
    Number(row.errors_encountered) < Number(row.error_limit)
  ) {
    return;
  }
  await tx.query(
    `update collection_jobs set status = 'cancelled', finished_at = now(),
            last_error = 'batch safety limit reached'
     where batch_id = $1 and status = 'queued'`,
    [batchId],
  );
}

async function finishBatchIfSettled(tx: SqlClient, batchId: Uuid): Promise<void> {
  const open = await tx.query<{ count: number }>(
    `select count(*)::int as count from collection_jobs
     where batch_id = $1 and status in ('queued','claimed','running')`,
    [batchId],
  );
  if (Number(open.rows[0]?.count ?? 0) > 0) return;
  await tx.query(
    `update collection_batches
     set status = case
           when errors_encountered > 0
             or exists (select 1 from collection_jobs where batch_id = $1 and (status in ('failed','policy_hold','cancelled') or outcome_detail is not null))
           then 'completed_with_errors'::collection_batch_status
           else 'completed'::collection_batch_status
         end,
         finished_at = now()
     where id = $1 and status in ('queued','running')`,
    [batchId],
  );
}

async function appendAudit(
  tx: SqlClient,
  actor: string,
  action: string,
  entityId: Uuid,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.query('select audit_event_append($1,$2,$3,$4,$5)', [
    actor,
    action,
    action.startsWith('collection_batch') ? 'collection_batch' : 'collection_project',
    entityId,
    JSON.stringify(payload),
  ]);
}

function validateProjectInput(input: CreateCollectionProjectInput): void {
  if (input.name.trim().length === 0) throw new Error('project name is required');
  if (input.sectorCodes.length === 0) throw new Error('at least one sector is required');
  if (input.governmentLevelCodes.length === 0) {
    throw new Error('at least one government level is required');
  }
  for (const [name, value, maximum] of [
    ['batch size', input.batchSize, 1000],
    ['pages per target', input.maxPagesPerTarget, 1000],
    ['pages per batch', input.maxPagesPerBatch, 100000],
    ['errors per batch', input.maxErrorsPerBatch, 1000],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be between 1 and ${maximum}`);
    }
  }
}

function normalizeFilters(
  filters: Partial<CollectionProjectFilters> = {},
): CollectionProjectFilters {
  return {
    stateCodes: unique(filters.stateCodes ?? []),
    allGovernmentLevels: filters.allGovernmentLevels === true,
    organizationTypeCodes: unique(filters.organizationTypeCodes ?? []),
    includedOrganizationIds: unique(filters.includedOrganizationIds ?? []),
    excludedOrganizationIds: unique(filters.excludedOrganizationIds ?? []),
    workMode:
      filters.workMode === 'operator_job_limit' ? 'operator_job_limit' : 'approved_batch_complete',
  };
}

function parseFilters(value: unknown): CollectionProjectFilters {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = {};
    }
  }
  if (parsed === null || typeof parsed !== 'object') return { ...EMPTY_FILTERS };
  const record = parsed as Record<string, unknown>;
  return normalizeFilters({
    stateCodes: stringArray(record['stateCodes']),
    allGovernmentLevels: record['allGovernmentLevels'] === true,
    organizationTypeCodes: stringArray(record['organizationTypeCodes']),
    includedOrganizationIds: stringArray(record['includedOrganizationIds']),
    excludedOrganizationIds: stringArray(record['excludedOrganizationIds']),
    workMode:
      record['workMode'] === 'operator_job_limit'
        ? 'operator_job_limit'
        : 'approved_batch_complete',
  });
}

function mapProject(row: Record<string, unknown>): CollectionProjectSummary {
  return {
    id: String(row['id']),
    key: String(row['key']),
    name: String(row['name']),
    jurisdictionConfigKey: String(row['jurisdiction_config_key']),
    jurisdictionId: nullableString(row['jurisdiction_id']),
    stateCode: nullableString(row['state_code']),
    sectorCodes: stringArray(row['sector_codes']),
    governmentLevelCodes: stringArray(row['government_level_codes']),
    filters: parseFilters(row['filters']),
    estimatedOrganizationCount:
      row['estimated_organization_count'] == null
        ? null
        : Number(row['estimated_organization_count']),
    batchSize: Number(row['batch_size']),
    maxPagesPerTarget: Number(row['max_pages_per_target']),
    maxPagesPerBatch: Number(row['max_pages_per_batch']),
    maxErrorsPerBatch: Number(row['max_errors_per_batch']),
    status: String(row['status']) as CollectionProjectStatus,
    organizationsSelected: Number(row['organizations_selected'] ?? 0),
    sourceRecordsSelected: Number(row['source_records_selected'] ?? 0),
    sourceRecordsReady: Number(row['source_records_ready'] ?? 0),
    sourceRecordsHeld: Number(row['source_records_held'] ?? 0),
    websitesAvailable: Number(row['websites_available'] ?? 0),
    directoriesReady: Number(row['directories_ready'] ?? 0),
    targetsCrawled: Number(row['targets_crawled'] ?? 0),
    recordsCollected: Number(row['records_collected'] ?? 0),
    failedJobs: Number(row['failed_jobs'] ?? 0),
    policyHolds: Number(row['policy_holds'] ?? 0),
    queuedJobs: Number(row['queued_jobs'] ?? 0),
    runningJobs: Number(row['running_jobs'] ?? 0),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  };
}

function mapBatch(row: Record<string, unknown>): CollectionBatchSummary {
  return {
    id: String(row['id']),
    sequenceNumber: Number(row['sequence_number']),
    kind: String(row['kind']) as CollectionJobKind,
    status: String(row['status']) as CollectionBatchStatus,
    targetLimit: Number(row['target_limit']),
    pageLimit: Number(row['page_limit']),
    errorLimit: Number(row['error_limit']),
    pagesProcessed: Number(row['pages_processed']),
    errorsEncountered: Number(row['errors_encountered']),
    approvedBy: nullableString(row['approved_by']),
    approvedAt: nullableIso(row['approved_at']),
    approvalNote: nullableString(row['approval_note']),
    completedJobs: Number(row['completed_jobs'] ?? 0),
    failedJobs: Number(row['failed_jobs'] ?? 0),
    heldJobs: Number(row['held_jobs'] ?? 0),
    queuedJobs: Number(row['queued_jobs'] ?? 0),
    createdAt: iso(row['created_at']),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function nullableString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value);
}

export function sourceDomain(url: string): string | null {
  return domainOf(url);
}

export type { CollectionJobKind, CollectionJobStatus };
