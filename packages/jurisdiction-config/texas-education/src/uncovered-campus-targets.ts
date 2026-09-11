import { canonicalizeUrl, urlHash } from '@public-workforce/core';
import { runAtomically, type SqlClient } from '@public-workforce/database';
import type { Uuid } from '@public-workforce/shared-types';
import { isApprovedHost } from './legacy-contact-import.js';

interface CampusCandidate {
  organization_id: Uuid;
  website_url: string | null;
  source_document_id: Uuid;
  covered: boolean;
  associated_target_urls: string[];
}

export interface UncoveredCampusTargetPlan {
  artifactRowsImported: number;
  selectedCampuses: number;
  alreadyCovered: number;
  missingWebsite: number;
  outsideApprovedDomains: number;
  invalidWebsite: number;
  eligibleCampuses: number;
  distinctWebsiteTargets: number;
  existingTargetAssociations: number;
  associationsToCreate: number;
}

export interface SeedUncoveredCampusTargetsResult extends UncoveredCampusTargetPlan {
  targetRowsCreated: number;
  associationsCreated: number;
}

/**
 * Prepares only Texas school sites that have no contact imported from the bound
 * legacy artifact. It creates pending targets; it cannot approve a source,
 * create a batch, enqueue a job, or start a worker.
 */
export async function planUncoveredCampusTargets(
  client: SqlClient,
  input: {
    projectId: Uuid;
    artifactId: string;
    approvedDomains: ReadonlySet<string>;
  },
): Promise<UncoveredCampusTargetPlan> {
  const candidates = await loadCandidates(client, input.projectId, input.artifactId);
  const artifactRowsImported = await countArtifactRows(client, input.artifactId);
  return summarize(candidates, input.approvedDomains, artifactRowsImported).plan;
}

export async function seedUncoveredCampusTargets(
  client: SqlClient,
  input: {
    projectId: Uuid;
    artifactId: string;
    expectedArtifactRecords: number;
    approvedDomains: ReadonlySet<string>;
    actor: string;
  },
): Promise<SeedUncoveredCampusTargetsResult> {
  if (input.actor.trim().length === 0) throw new Error('actor is required');
  if (input.artifactId.trim().length === 0) throw new Error('artifact id is required');
  if (!Number.isSafeInteger(input.expectedArtifactRecords) || input.expectedArtifactRecords < 1)
    throw new Error('expected artifact record count must be a positive integer');
  return runAtomically(client, async (tx) => {
    const artifactRowsImported = await countArtifactRows(tx, input.artifactId);
    if (artifactRowsImported !== input.expectedArtifactRecords)
      throw new Error(
        `artifact import is incomplete: expected ${input.expectedArtifactRecords} records, found ${artifactRowsImported}`,
      );
    const candidates = await loadCandidates(tx, input.projectId, input.artifactId, true);
    const { plan, eligible } = summarize(candidates, input.approvedDomains, artifactRowsImported);
    let targetRowsCreated = 0;
    let associationsCreated = 0;

    for (const candidate of eligible) {
      const inserted = await tx.query<{ id: Uuid; inserted: boolean }>(
        `insert into crawl_targets (
           organization_id, jurisdiction_id, url, url_hash, target_type,
           source_type_code, status, priority
         ) select organization.id,organization.jurisdiction_id,$2,$3,
                  'organization_site','html_directory','pending',100
           from organizations organization where organization.id=$1
         on conflict (url_hash) do update set updated_at=crawl_targets.updated_at
         returning id,(xmax=0) as inserted`,
        [candidate.organization_id, candidate.url, urlHash(candidate.url)],
      );
      const target = inserted.rows[0];
      if (target === undefined) throw new Error('organization disappeared while preparing target');
      if (target.inserted) targetRowsCreated += 1;
      const linked = await tx.query(
        `insert into crawl_target_organizations (
           crawl_target_id,organization_id,source_document_id
         ) values ($1,$2,$3) on conflict do nothing returning crawl_target_id`,
        [target.id, candidate.organization_id, candidate.source_document_id],
      );
      associationsCreated += linked.rows.length;
    }

    await tx.query('select audit_event_append($1,$2,$3,$4,$5)', [
      input.actor.trim(),
      'collection_project.uncovered_targets_prepared',
      'collection_project',
      input.projectId,
      JSON.stringify({ ...plan, targetRowsCreated, associationsCreated }),
    ]);
    return { ...plan, targetRowsCreated, associationsCreated };
  });
}

async function loadCandidates(
  client: SqlClient,
  projectId: Uuid,
  artifactId: string,
  lockProject = false,
): Promise<CampusCandidate[]> {
  const project = await client.query<{
    state_code: string | null;
    sector_codes: string[];
    filters: unknown;
  }>(
    `select state_code,sector_codes,filters from collection_projects where id=$1${lockProject ? ' for update' : ''}`,
    [projectId],
  );
  const row = project.rows[0];
  if (row === undefined) throw new Error('collection project not found');
  const filters = asRecord(row.filters);
  const filterStates = Array.isArray(filters['stateCodes'])
    ? filters['stateCodes'].filter((value): value is string => typeof value === 'string')
    : [];
  const states = row.state_code === null ? filterStates : [row.state_code];
  if (
    states.length !== 1 ||
    states[0] !== 'TX' ||
    row.sector_codes.length !== 1 ||
    row.sector_codes[0] !== 'education'
  )
    throw new Error('project must be scoped only to Texas public education');

  return (
    await client.query<CampusCandidate>(
      `select organization.id as organization_id,organization.website_url,
              organization.source_document_id,
              exists(
                select 1 from employment_assignments assignment
                join source_observations observation
                  on observation.entity_type='person' and observation.entity_id=assignment.person_id
                 and observation.field='legacy_artifact_id'
                 and observation.value_normalized=$2
                where assignment.organization_id=organization.id
              ) as covered,
              coalesce((
                select array_agg(target.url order by target.url)
                from crawl_target_organizations target_link
                join crawl_targets target on target.id=target_link.crawl_target_id
                where target_link.organization_id=organization.id
                  and target.target_type='organization_site'
              ),array[]::text[]) as associated_target_urls
       from collection_project_organizations scope
       join organizations organization on organization.id=scope.organization_id
       where scope.project_id=$1 and organization.organization_type_code='school'
       order by organization.id`,
      [projectId, artifactId],
    )
  ).rows;
}

function summarize(
  candidates: readonly CampusCandidate[],
  approvedDomains: ReadonlySet<string>,
  artifactRowsImported: number,
): { plan: UncoveredCampusTargetPlan; eligible: (CampusCandidate & { url: string })[] } {
  let alreadyCovered = 0;
  let missingWebsite = 0;
  let outsideApprovedDomains = 0;
  let invalidWebsite = 0;
  let existingTargetAssociations = 0;
  const eligible: (CampusCandidate & { url: string })[] = [];
  for (const candidate of candidates) {
    if (candidate.covered) {
      alreadyCovered += 1;
      continue;
    }
    if (candidate.website_url === null || candidate.website_url.trim().length === 0) {
      missingWebsite += 1;
      continue;
    }
    const url = canonicalizeUrl(candidate.website_url);
    if (url === null) {
      invalidWebsite += 1;
      continue;
    }
    if (!isApprovedHost(new URL(url).hostname, approvedDomains)) {
      outsideApprovedDomains += 1;
      continue;
    }
    if (candidate.associated_target_urls.some((targetUrl) => canonicalizeUrl(targetUrl) === url))
      existingTargetAssociations += 1;
    eligible.push({ ...candidate, url });
  }
  return {
    plan: {
      artifactRowsImported,
      selectedCampuses: candidates.length,
      alreadyCovered,
      missingWebsite,
      outsideApprovedDomains,
      invalidWebsite,
      eligibleCampuses: eligible.length,
      distinctWebsiteTargets: new Set(eligible.map((candidate) => candidate.url)).size,
      existingTargetAssociations,
      associationsToCreate: eligible.length - existingTargetAssociations,
    },
    eligible,
  };
}

async function countArtifactRows(client: SqlClient, artifactId: string): Promise<number> {
  const result = await client.query<{ count: number }>(
    `select count(distinct record_key)::int as count from source_observations
     where field='legacy_artifact_id'
       and value_normalized=$1
       and extraction_method_code='file_import'`,
    [artifactId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
