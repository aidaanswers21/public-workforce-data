import type { ExportablePersonRow } from '@public-workforce/core';
import type { Timestamp, Uuid } from '@public-workforce/shared-types';
import type { SqlClient } from '../client.js';

export interface ExportFilters {
  governmentLevelCode?: string;
  sectorCode?: string;
  jurisdictionId?: Uuid;
  organizationId?: Uuid;
  collectionProjectId?: Uuid;
  /** Include everything under the organization, not only its own staff. */
  includeOrganizationSubtree?: boolean;
  stateCode?: string;
  roleCategoryCodes?: readonly string[];
  assignmentStatuses?: readonly string[];
  includeInferredOnly?: boolean;
  includePhoneOnly?: boolean;
  includeGeneralInboxes?: boolean;
  limit?: number;
  afterAssignmentId?: Uuid;
  snapshotAt?: Timestamp;
  paginateByAssignment?: boolean;
}

/**
 * Organization ancestry, computed once per query.
 *
 * Only containment relationships are followed, which the taxonomy marks with
 * `implies_subtree`. Depth is bounded so a cycle in collected data cannot hang
 * the query, and the same rule is implemented in `OrganizationHierarchy` for
 * the in-memory re-check on the export path.
 */
const ORG_ANCESTRY_CTE = `
  org_ancestry as (
    select o.id as organization_id, o.id as ancestor_id, 0 as depth
    from organizations o
    union all
    select a.organization_id, r.parent_organization_id, a.depth + 1
    from org_ancestry a
    join organization_relationships r on r.child_organization_id = a.ancestor_id
    join relationship_types rt on rt.code = r.relationship_type_code and rt.implies_subtree
    where a.depth < 12
      and r.effective_from <= current_date
      and (r.effective_to is null or r.effective_to >= current_date)
  )
`;

/**
 * Resolve all currently suppressed organization subtrees once.
 *
 * Keeping this outside the person-correlated predicate avoids rescanning the
 * complete ancestry result for every assignment at national scale.
 */
const SUPPRESSED_SUBTREES_CTE = `
  active_suppressions as materialized (
    select * from suppression_entries
    where revoked_at is null
      and effective_at <= $1::timestamptz
      and (expires_at is null or expires_at > $1::timestamptz)
  ),
  suppressed_subtree_organizations as (
    select organization_id
    from active_suppressions
    where scope = 'organization_subtree' and organization_id is not null
    union
    select r.child_organization_id
    from suppressed_subtree_organizations suppressed
    join organization_relationships r
      on r.parent_organization_id = suppressed.organization_id
    join relationship_types rt
      on rt.code = r.relationship_type_code and rt.implies_subtree
    where r.effective_from <= current_date
      and (r.effective_to is null or r.effective_to >= current_date)
  ),
  suppressed_geographic_areas as (
    select geographic_area_id
    from active_suppressions
    where scope = 'geographic_area' and geographic_area_id is not null
    union
    select area.id
    from suppressed_geographic_areas suppressed
    join geographic_areas area on area.parent_area_id = suppressed.geographic_area_id
  )
`;

/**
 * Suppression applied in SQL, not by the caller.
 *
 * This is the data layer's half of the guarantee: a consumer that forgets to
 * re-check still cannot read a suppressed person out of the database. The export
 * path re-checks anyway, because an opt-out recorded between this query and the
 * file being written must still take effect.
 *
 * `$1` is the evaluation time and `$2` is the declared export purpose.
 */
const SUPPRESSION_FILTER = `
  emp.organization_id not in (
    select organization_id from suppressed_subtree_organizations
  )
  and
  (
    loc.geographic_area_id is null
    or loc.geographic_area_id not in (
      select geographic_area_id from suppressed_geographic_areas
    )
  )
  and
  not exists (
    select 1 from active_suppressions s
    where (
        s.scope = 'global'
        or (s.scope = 'person' and s.person_id = p.id)
        or (s.scope = 'organization' and s.organization_id = emp.organization_id)
        or (s.scope = 'jurisdiction' and s.jurisdiction_id = org.jurisdiction_id)
        or (s.scope = 'government_level' and s.government_level_code = org.government_level_code)
        or (s.scope = 'source' and s.source_document_id = emp.source_document_id)
        or (s.scope = 'export_purpose' and s.export_purpose = $2)
      )
  )
`;

function addressSuppressionFilter(address: string, domain: string): string {
  return `not exists (
    select 1 from suppression_entries address_suppression
    where address_suppression.revoked_at is null
      and address_suppression.effective_at <= $1::timestamptz
      and (
        address_suppression.expires_at is null
        or address_suppression.expires_at > $1::timestamptz
      )
      and (
        (address_suppression.scope = 'email' and address_suppression.value = ${address})
        or (
          address_suppression.scope = 'domain'
          and (
            ${domain} = address_suppression.value
            or ${domain} like '%.' || address_suppression.value
          )
        )
      )
  )`;
}

export class QueryRepository {
  constructor(private readonly client: SqlClient) {}

  async queryExportableRows(
    at: Timestamp,
    purpose: string,
    filters: ExportFilters = {},
  ): Promise<ExportablePersonRow[]> {
    const conditions: string[] = [SUPPRESSION_FILTER];
    const params: unknown[] = [at, purpose];

    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (filters.afterAssignmentId !== undefined)
      conditions.push(`emp.id > ${bind(filters.afterAssignmentId)}::uuid`);
    if (filters.snapshotAt !== undefined)
      conditions.push(`emp.created_at <= ${bind(filters.snapshotAt)}::timestamptz`);
    if (filters.governmentLevelCode !== undefined) {
      conditions.push(`org.government_level_code = ${bind(filters.governmentLevelCode)}`);
    }
    if (filters.sectorCode !== undefined)
      conditions.push(`org.sector_code = ${bind(filters.sectorCode)}`);
    if (filters.jurisdictionId !== undefined)
      conditions.push(`org.jurisdiction_id = ${bind(filters.jurisdictionId)}`);
    if (filters.organizationId !== undefined) {
      conditions.push(
        filters.includeOrganizationSubtree === true
          ? `exists (select 1 from org_ancestry oa2 where oa2.organization_id = emp.organization_id and oa2.ancestor_id = ${bind(filters.organizationId)})`
          : `emp.organization_id = ${bind(filters.organizationId)}`,
      );
    }
    if (filters.collectionProjectId !== undefined) {
      conditions.push(
        `exists (
           select 1 from collection_project_organizations project_org
           where project_org.project_id = ${bind(filters.collectionProjectId)}
             and project_org.organization_id = emp.organization_id
         )`,
      );
    }
    if (filters.stateCode !== undefined) {
      conditions.push(
        `coalesce(loc.state_code, area_state.state_code) = ${bind(filters.stateCode.toUpperCase())}`,
      );
    }
    if (filters.roleCategoryCodes !== undefined && filters.roleCategoryCodes.length > 0) {
      conditions.push(
        `emp.role_category_code = any(${bind([...filters.roleCategoryCodes])}::text[])`,
      );
    }
    conditions.push(
      filters.assignmentStatuses !== undefined && filters.assignmentStatuses.length > 0
        ? `emp.assignment_status = any(${bind([...filters.assignmentStatuses])}::assignment_status[])`
        : `emp.assignment_status = 'active'`,
    );
    if (filters.includeGeneralInboxes !== true) {
      conditions.push(`(ea.classification is null or ea.classification <> 'general_inbox')`);
    }
    if (filters.includeInferredOnly !== true) {
      // This is a source-evidence filter, not a suppression decision. A person
      // whose published address was withheld may still export a separately
      // permitted candidate because the source did publish an address for them.
      conditions.push(
        `(exists (select 1 from email_addresses source_ea where source_ea.person_id = p.id) ${filters.includePhoneOnly === true ? `or exists(select 1 from contact_points cp where cp.person_id=p.id and cp.contact_point_type_code='work_phone' and cp.status='active')` : ''})`,
      );
    }
    conditions.push(
      `(ea.id is not null or ec.id is not null ${filters.includePhoneOnly === true ? `or exists(select 1 from contact_points cp where cp.person_id=p.id and cp.contact_point_type_code='work_phone' and cp.status='active' and (cp.organization_id is null or cp.organization_id=emp.organization_id) and not exists(select 1 from active_suppressions ps where ps.scope='source' and ps.source_document_id=cp.source_document_id))` : ''})`,
    );

    const limitClause = filters.limit === undefined ? '' : `limit ${Number(filters.limit)}`;

    const result = await this.client.query<Record<string, unknown>>(
      `with recursive ${ORG_ANCESTRY_CTE}, ${SUPPRESSED_SUBTREES_CTE}
       select
         emp.id as assignment_id, p.id as person_id, p.first_name, p.middle_name, p.last_name, p.full_name_published,
         p.status as person_status,
         emp.title_published, emp.title_normalized, emp.role_category_code, emp.job_family_code,
         emp.seniority_code, emp.department_published, emp.assignment_status,
         emp.extraction_method_code, emp.confidence, emp.first_seen_at, emp.last_seen_at, emp.crawl_run_id,
         emp.source_document_id,
         unit.name as unit_name,
         (select coalesce(jsonb_agg(jsonb_build_object('value',published.address,'sourceDocumentId',published.source_document_id) order by published.id),'[]'::jsonb)
          from email_addresses published where published.person_id=p.id and published.status='active'
            and (published.organization_id is null or published.organization_id=emp.organization_id)
            and published.classification in ('published','decoded_published'${filters.includeGeneralInboxes === true ? ", 'general_inbox'" : ''})
            and ${addressSuppressionFilter('published.address_normalized', 'published.domain')}
            and not exists(select 1 from active_suppressions ps where ps.scope='source' and ps.source_document_id=published.source_document_id)) as all_published_emails,
         (select coalesce(jsonb_agg(jsonb_build_object('value',coalesce(cp.source_value,cp.value),'sourceDocumentId',cp.source_document_id) order by cp.id),'[]'::jsonb)
          from contact_points cp where cp.status='active' and cp.person_id=p.id and (cp.organization_id is null or cp.organization_id=emp.organization_id) and cp.contact_point_type_code='work_phone'
            and not exists(select 1 from active_suppressions ps where ps.scope='source' and ps.source_document_id=cp.source_document_id)) as work_phones,
         org.id as organization_id, org.name as organization_name,
         org.organization_type_code, org.government_level_code, org.sector_code, org.jurisdiction_id,
         j.name as jurisdiction_name,
         parent_org.id as parent_organization_id, parent_org.name as parent_organization_name,
         (select array_agg(oa3.ancestor_id) from org_ancestry oa3
            where oa3.organization_id = emp.organization_id and oa3.depth > 0) as ancestor_ids,
         loc.city as duty_city, coalesce(loc.state_code, area_state.state_code) as duty_state,
         county_area.name as duty_county, loc.geographic_area_id,
         ea.address as published_email, ea.classification as email_classification,
         ea.validation_status as email_validation_status,
         ec.address as inferred_email_candidate, ec.confidence as inference_confidence,
         exists (
           select 1 from email_candidates withheld_candidate
           where withheld_candidate.person_id = p.id
             and withheld_candidate.state not in ('rejected', 'suppressed')
             and not (${addressSuppressionFilter(
               'withheld_candidate.address',
               'withheld_candidate.domain',
             )})
         ) as inferred_candidate_withheld,
         sd.url as source_url, sd.source_type_code
       from people p
       join employment_assignments emp on emp.person_id = p.id
       join organizations org on org.id = emp.organization_id
       left join jurisdictions j on j.id = org.jurisdiction_id
       left join organizational_units unit on unit.id = emp.organizational_unit_id
       left join organization_locations loc on loc.id = emp.duty_location_id
       left join geographic_areas area_state on area_state.id = loc.geographic_area_id
       left join geographic_areas county_area
         on county_area.id = loc.geographic_area_id and county_area.area_type_code = 'county'
       left join lateral (
         select po.id, po.name from org_ancestry oa
         join organizations po on po.id = oa.ancestor_id
         where oa.organization_id = emp.organization_id and oa.depth = 1
         limit 1
       ) parent_org on true
       left join lateral (
         select * from email_addresses e
         where e.person_id = p.id
           and ${addressSuppressionFilter('e.address_normalized', 'e.domain')}
         order by case e.classification
           when 'published' then 0 when 'decoded_published' then 1
           when 'general_inbox' then 2 else 3 end, e.last_seen_at desc
         limit 1
       ) ea on true
       left join lateral (
         select * from email_candidates c
         -- Both terminal states are excluded. A rejected candidate was a wrong
         -- inference; a suppressed one is an address somebody asked us not to
         -- use, and letting that through would put a withheld address into an
         -- export before the in-memory re-check ever saw it.
         where c.person_id = p.id and c.state not in ('rejected', 'suppressed')
           and ${addressSuppressionFilter('c.address', 'c.domain')}
         order by c.confidence desc limit 1
       ) ec on true
       left join source_documents sd on sd.id = emp.source_document_id
       where ${conditions.join(' and ')}
       order by ${filters.paginateByAssignment === true ? 'emp.id' : 'p.last_name nulls last, p.first_name nulls last, p.id'}
       ${limitClause}`,
      params,
    );

    return result.rows.map(toExportRow);
  }

  /** Counts behind the admin coverage view, scoped however the caller asks. */
  async coverageSummary(
    scope: { governmentLevelCode?: string; sectorCode?: string } = {},
  ): Promise<CoverageSummary> {
    const params: unknown[] = [scope.governmentLevelCode ?? null, scope.sectorCode ?? null];
    const orgFilter = `($1::text is null or o.government_level_code = $1) and ($2::text is null or o.sector_code = $2)`;

    const result = await this.client.query<Record<string, unknown>>(
      `select
         (select count(*) from organizations o where ${orgFilter}) as organizations,
         (select count(distinct o.government_level_code) from organizations o where ${orgFilter}) as government_levels,
         (select count(*) from organization_relationships) as relationships,
         (select count(*) from crawl_targets) as targets,
         (select count(*) from crawl_targets where status = 'crawled') as targets_crawled,
         (select count(*) from crawl_targets where status in ('failed','blocked')) as targets_failed,
         (select count(*) from crawl_targets where status = 'unsupported_platform') as unsupported_platforms,
         (select count(*) from crawl_targets where status = 'policy_hold') as targets_policy_hold,
         (select count(*) from people p join employment_assignments e on e.person_id = p.id
            join organizations o on o.id = e.organization_id where ${orgFilter}) as people,
         (select count(*) from email_addresses ea join organizations o on o.id = ea.organization_id
            where ${orgFilter} and ea.classification in ('published','decoded_published')) as published_emails,
         (select count(*) from email_addresses ea join organizations o on o.id = ea.organization_id
            where ${orgFilter} and ea.classification = 'general_inbox') as general_inboxes,
         (select count(*) from email_candidates
            where state not in ('rejected', 'suppressed')) as inferred_candidates,
         (select count(*) from email_candidates where validation_status = 'valid') as validated_candidates,
         (select count(*) from contact_points) as contact_points,
         (select count(*) from suppression_entries where revoked_at is null) as suppression_entries,
         (select count(*) from source_policies where collection_status = 'permitted') as policies_permitted,
         (select count(*) from source_policies where collection_status in ('prohibited','review_required')) as policies_blocking,
         (select max(finished_at) from crawl_runs) as last_crawl_at`,
      params,
    );
    const row = result.rows[0] ?? {};
    return {
      governmentLevelCode: scope.governmentLevelCode ?? null,
      sectorCode: scope.sectorCode ?? null,
      organizations: num(row['organizations']),
      governmentLevels: num(row['government_levels']),
      relationships: num(row['relationships']),
      targets: num(row['targets']),
      targetsCrawled: num(row['targets_crawled']),
      targetsFailed: num(row['targets_failed']),
      unsupportedPlatforms: num(row['unsupported_platforms']),
      targetsPolicyHold: num(row['targets_policy_hold']),
      people: num(row['people']),
      publishedEmails: num(row['published_emails']),
      generalInboxes: num(row['general_inboxes']),
      inferredCandidates: num(row['inferred_candidates']),
      validatedCandidates: num(row['validated_candidates']),
      contactPoints: num(row['contact_points']),
      suppressionEntries: num(row['suppression_entries']),
      policiesPermitted: num(row['policies_permitted']),
      policiesBlocking: num(row['policies_blocking']),
      lastCrawlAt: row['last_crawl_at'] == null ? null : toIso(row['last_crawl_at']),
    };
  }

  /** Published name-and-address pairs on one domain, used to learn its pattern. */
  async publishedPairsForDomain(
    domain: string,
  ): Promise<{ fullNamePublished: string; address: string }[]> {
    const result = await this.client.query<{ full_name_published: string; address: string }>(
      `select p.full_name_published, e.address_normalized as address
       from email_addresses e join people p on p.id = e.person_id
       where e.domain = $1 and e.classification in ('published','decoded_published')`,
      [domain.toLowerCase()],
    );
    return result.rows.map((row) => ({
      fullNamePublished: row.full_name_published,
      address: row.address,
    }));
  }
}

export interface CoverageSummary {
  governmentLevelCode: string | null;
  sectorCode: string | null;
  organizations: number;
  governmentLevels: number;
  relationships: number;
  targets: number;
  targetsCrawled: number;
  targetsFailed: number;
  unsupportedPlatforms: number;
  targetsPolicyHold: number;
  people: number;
  publishedEmails: number;
  generalInboxes: number;
  inferredCandidates: number;
  validatedCandidates: number;
  contactPoints: number;
  suppressionEntries: number;
  policiesPermitted: number;
  policiesBlocking: number;
  lastCrawlAt: string | null;
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Convert a driver timestamp to ISO-8601 without losing precision.
 * Going via `String(date)` renders a form with no milliseconds.
 */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function toExportRow(row: Record<string, unknown>): ExportablePersonRow {
  const ancestors = Array.isArray(row['ancestor_ids']) ? (row['ancestor_ids'] as Uuid[]) : [];
  const areaId = (row['geographic_area_id'] as Uuid | null) ?? null;
  return {
    personId: row['person_id'] as Uuid,
    assignmentId: row['assignment_id'] as Uuid,
    publishedEmails: (row['all_published_emails'] ?? []) as {
      value: string;
      sourceDocumentId: Uuid;
    }[],
    workPhones: (row['work_phones'] ?? []) as { value: string; sourceDocumentId: Uuid }[],
    firstName: (row['first_name'] as string | null) ?? null,
    middleName: (row['middle_name'] as string | null) ?? null,
    lastName: (row['last_name'] as string | null) ?? null,
    fullNamePublished: row['full_name_published'] as string,
    titlePublished: (row['title_published'] as string | null) ?? null,
    titleNormalized: (row['title_normalized'] as string | null) ?? null,
    roleCategoryCode: (row['role_category_code'] as string | null) ?? 'unknown',
    jobFamilyCode: (row['job_family_code'] as string | null) ?? 'unknown',
    seniorityCode: (row['seniority_code'] as string | null) ?? 'unknown',
    departmentPublished: (row['department_published'] as string | null) ?? null,
    organizationalUnitName: (row['unit_name'] as string | null) ?? null,
    organizationId: (row['organization_id'] as Uuid | null) ?? null,
    organizationName: (row['organization_name'] as string | null) ?? null,
    organizationTypeCode: (row['organization_type_code'] as string | null) ?? null,
    governmentLevelCode: (row['government_level_code'] as string | null) ?? null,
    sectorCode: (row['sector_code'] as string | null) ?? null,
    parentOrganizationId: (row['parent_organization_id'] as Uuid | null) ?? null,
    parentOrganizationName: (row['parent_organization_name'] as string | null) ?? null,
    organizationAncestorIds: ancestors,
    jurisdictionId: (row['jurisdiction_id'] as Uuid | null) ?? null,
    jurisdictionName: (row['jurisdiction_name'] as string | null) ?? null,
    dutyLocationCity: (row['duty_city'] as string | null) ?? null,
    dutyLocationStateCode: (row['duty_state'] as string | null) ?? null,
    dutyLocationCountyName: (row['duty_county'] as string | null) ?? null,
    geographicAreaIds: areaId === null ? [] : [areaId],
    publishedEmail: (row['published_email'] as string | null) ?? null,
    inferredEmailCandidate: (row['inferred_email_candidate'] as string | null) ?? null,
    inferredCandidateWithheld: Boolean(row['inferred_candidate_withheld']),
    emailClassification:
      (row['email_classification'] as ExportablePersonRow['emailClassification']) ?? null,
    emailValidationStatus:
      (row['email_validation_status'] as ExportablePersonRow['emailValidationStatus']) ??
      'unvalidated',
    inferenceConfidence:
      row['inference_confidence'] == null ? null : Number(row['inference_confidence']),
    sourceUrl: (row['source_url'] as string | null) ?? null,
    sourceTypeCode: (row['source_type_code'] as string | null) ?? null,
    sourceDocumentId: (row['source_document_id'] as Uuid | null) ?? null,
    firstSeenAt: toIso(row['first_seen_at']),
    lastSeenAt: toIso(row['last_seen_at']),
    crawlRunId: (row['crawl_run_id'] as Uuid | null) ?? null,
    extractionMethod: row['extraction_method_code'] as ExportablePersonRow['extractionMethod'],
    confidence: Number(row['confidence'] ?? 0),
    assignmentStatus:
      (row['assignment_status'] as ExportablePersonRow['assignmentStatus']) ?? 'unknown',
    status: (row['person_status'] as ExportablePersonRow['status']) ?? 'active',
  };
}
