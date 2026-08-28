import type { ExportablePersonRow } from '@pan/core';
import type { Timestamp, Uuid } from '@pan/shared-types';
import type { SqlClient } from '../client.js';

export interface ExportFilters {
  stateCode?: string;
  districtId?: Uuid;
  schoolId?: Uuid;
  roleCategories?: readonly string[];
  /** Include rows whose only address is an inferred candidate. Off by default. */
  includeInferredOnly?: boolean;
  /** Include shared office inboxes. Off by default. */
  includeGeneralInboxes?: boolean;
  limit?: number;
}

/**
 * Suppression is applied in SQL, not by the caller.
 *
 * This subquery is the data layer's half of the guarantee: a consumer that
 * forgets to re-check still cannot read a suppressed person out of the
 * database. The export path re-checks anyway, because an opt-out recorded
 * between this query and the file being written must still take effect.
 */
const SUPPRESSION_FILTER = `
  not exists (
    select 1 from suppression_entries s
    where s.revoked_at is null
      and s.effective_at <= $1::timestamptz
      and (s.expires_at is null or s.expires_at > $1::timestamptz)
      and (
        s.scope = 'global'
        or (s.scope = 'email' and s.value in (
              coalesce(ea.address_normalized, ''), coalesce(ec.address, '')))
        or (s.scope = 'domain' and (
              coalesce(ea.domain, '') = s.value or coalesce(ea.domain, '') like '%.' || s.value
              or coalesce(ec.domain, '') = s.value or coalesce(ec.domain, '') like '%.' || s.value))
        or (s.scope = 'person' and s.person_id = p.id)
        or (s.scope = 'school' and s.school_id = emp.school_id)
        or (s.scope = 'district' and s.district_id = emp.district_id)
        or (s.scope = 'state' and s.state_id = p.state_id)
      )
  )
`;

/** Read the rows an export would contain, already filtered by suppression. */
export class QueryRepository {
  constructor(private readonly client: SqlClient) {}

  async queryExportableRows(
    at: Timestamp,
    filters: ExportFilters = {},
  ): Promise<ExportablePersonRow[]> {
    const conditions: string[] = [SUPPRESSION_FILTER];
    const params: unknown[] = [at];

    if (filters.stateCode !== undefined) {
      params.push(filters.stateCode.toUpperCase());
      conditions.push(`st.code = $${params.length}`);
    }
    if (filters.districtId !== undefined) {
      params.push(filters.districtId);
      conditions.push(`emp.district_id = $${params.length}`);
    }
    if (filters.schoolId !== undefined) {
      params.push(filters.schoolId);
      conditions.push(`emp.school_id = $${params.length}`);
    }
    if (filters.roleCategories !== undefined && filters.roleCategories.length > 0) {
      params.push(filters.roleCategories);
      conditions.push(`emp.role_category = any($${params.length}::role_category[])`);
    }
    if (filters.includeGeneralInboxes !== true) {
      conditions.push(`(ea.classification is null or ea.classification <> 'general_inbox')`);
    }
    if (filters.includeInferredOnly !== true) {
      conditions.push(`ea.id is not null`);
    }

    const limitClause = filters.limit === undefined ? '' : `limit ${Number(filters.limit)}`;

    const result = await this.client.query<Record<string, unknown>>(
      `select
         p.id as person_id, p.first_name, p.middle_name, p.last_name, p.full_name_published,
         p.status as person_status, p.state_id,
         emp.title_published, emp.title_normalized, emp.role_category, emp.school_id, emp.district_id,
         emp.extraction_method, emp.confidence, emp.first_seen_at, emp.last_seen_at, emp.crawl_run_id,
         dep.name as department_name,
         sch.name as school_name,
         dis.name as district_name,
         cty.name as county_name,
         st.code as state_code,
         ea.address as published_email, ea.classification as email_classification,
         ea.validation_status as email_validation_status,
         ec.address as inferred_email_candidate, ec.confidence as inference_confidence,
         sp.url as source_url, sp.source_type
       from people p
       join employment_assignments emp on emp.person_id = p.id
       join states st on st.id = p.state_id
       left join departments dep on dep.id = emp.department_id
       left join schools sch on sch.id = emp.school_id
       left join districts dis on dis.id = coalesce(emp.district_id, sch.district_id)
       left join counties cty on cty.id = coalesce(dis.county_id, sch.county_id)
       left join lateral (
         select * from email_addresses e
         where e.person_id = p.id
         order by case e.classification
           when 'published' then 0 when 'decoded_published' then 1
           when 'general_inbox' then 2 else 3 end, e.last_seen_at desc
         limit 1
       ) ea on true
       left join lateral (
         select * from email_candidates c
         where c.person_id = p.id and c.state <> 'rejected'
         order by c.confidence desc limit 1
       ) ec on true
       left join source_pages sp on sp.id = emp.source_page_id
       where ${conditions.join(' and ')}
       order by p.last_name nulls last, p.first_name nulls last, p.id
       ${limitClause}`,
      params,
    );

    return result.rows.map(toExportRow);
  }

  /** Counts behind the admin coverage view. */
  async coverageSummary(stateCode: string): Promise<CoverageSummary> {
    const result = await this.client.query<Record<string, unknown>>(
      `select
         (select count(*) from districts d join states s on s.id = d.state_id where s.code = $1) as districts,
         (select count(*) from schools sc join states s on s.id = sc.state_id where s.code = $1) as schools,
         (select count(*) from crawl_targets t join states s on s.id = t.state_id
            where s.code = $1 and t.target_type in ('district_directory','school_directory','department_directory')) as directories_discovered,
         (select count(*) from crawl_targets t join states s on s.id = t.state_id
            where s.code = $1 and t.status = 'crawled') as targets_crawled,
         (select count(*) from crawl_targets t join states s on s.id = t.state_id
            where s.code = $1 and t.status in ('failed','blocked')) as targets_failed,
         (select count(*) from crawl_targets t join states s on s.id = t.state_id
            where s.code = $1 and t.status = 'unsupported_platform') as unsupported_platforms,
         (select count(*) from people p join states s on s.id = p.state_id where s.code = $1) as people,
         (select count(*) from email_addresses e join people p on p.id = e.person_id
            join states s on s.id = p.state_id
            where s.code = $1 and e.classification in ('published','decoded_published')) as published_emails,
         (select count(*) from email_addresses e join people p on p.id = e.person_id
            join states s on s.id = p.state_id
            where s.code = $1 and e.classification = 'general_inbox') as general_inboxes,
         (select count(*) from email_candidates c join people p on p.id = c.person_id
            join states s on s.id = p.state_id where s.code = $1) as inferred_candidates,
         (select count(*) from email_candidates c join people p on p.id = c.person_id
            join states s on s.id = p.state_id where s.code = $1 and c.validation_status = 'valid') as validated_candidates,
         (select count(*) from suppression_entries where revoked_at is null) as suppression_entries,
         (select max(finished_at) from crawl_runs r join states s on s.id = r.state_id where s.code = $1) as last_crawl_at`,
      [stateCode.toUpperCase()],
    );
    const row = result.rows[0] ?? {};
    return {
      stateCode: stateCode.toUpperCase(),
      districts: num(row['districts']),
      schools: num(row['schools']),
      directoriesDiscovered: num(row['directories_discovered']),
      targetsCrawled: num(row['targets_crawled']),
      targetsFailed: num(row['targets_failed']),
      unsupportedPlatforms: num(row['unsupported_platforms']),
      people: num(row['people']),
      publishedEmails: num(row['published_emails']),
      generalInboxes: num(row['general_inboxes']),
      inferredCandidates: num(row['inferred_candidates']),
      validatedCandidates: num(row['validated_candidates']),
      suppressionEntries: num(row['suppression_entries']),
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
  stateCode: string;
  districts: number;
  schools: number;
  directoriesDiscovered: number;
  targetsCrawled: number;
  targetsFailed: number;
  unsupportedPlatforms: number;
  people: number;
  publishedEmails: number;
  generalInboxes: number;
  inferredCandidates: number;
  validatedCandidates: number;
  suppressionEntries: number;
  lastCrawlAt: string | null;
}

/**
 * Convert a driver timestamp to ISO-8601 without losing precision.
 *
 * Going via `String(date)` renders a human-readable form with no milliseconds,
 * which silently truncates every timestamp the database returns.
 */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toExportRow(row: Record<string, unknown>): ExportablePersonRow {
  return {
    personId: row['person_id'] as string,
    firstName: (row['first_name'] as string | null) ?? null,
    middleName: (row['middle_name'] as string | null) ?? null,
    lastName: (row['last_name'] as string | null) ?? null,
    fullNamePublished: row['full_name_published'] as string,
    titlePublished: (row['title_published'] as string | null) ?? null,
    titleNormalized: (row['title_normalized'] as string | null) ?? null,
    roleCategory: row['role_category'] as ExportablePersonRow['roleCategory'],
    department: (row['department_name'] as string | null) ?? null,
    schoolName: (row['school_name'] as string | null) ?? null,
    districtName: (row['district_name'] as string | null) ?? null,
    countyName: (row['county_name'] as string | null) ?? null,
    stateCode: row['state_code'] as string,
    publishedEmail: (row['published_email'] as string | null) ?? null,
    inferredEmailCandidate: (row['inferred_email_candidate'] as string | null) ?? null,
    emailClassification:
      (row['email_classification'] as ExportablePersonRow['emailClassification']) ?? null,
    emailValidationStatus:
      (row['email_validation_status'] as ExportablePersonRow['emailValidationStatus']) ??
      'unvalidated',
    inferenceConfidence:
      row['inference_confidence'] == null ? null : Number(row['inference_confidence']),
    sourceUrl: (row['source_url'] as string | null) ?? null,
    sourceType: (row['source_type'] as ExportablePersonRow['sourceType']) ?? null,
    firstSeenAt: toIso(row['first_seen_at']),
    lastSeenAt: toIso(row['last_seen_at']),
    crawlRunId: (row['crawl_run_id'] as string | null) ?? null,
    extractionMethod: row['extraction_method'] as ExportablePersonRow['extractionMethod'],
    confidence: Number(row['confidence'] ?? 0),
    status: (row['person_status'] as ExportablePersonRow['status']) ?? 'active',
    schoolId: (row['school_id'] as string | null) ?? null,
    districtId: (row['district_id'] as string | null) ?? null,
    stateId: (row['state_id'] as string | null) ?? null,
  };
}
