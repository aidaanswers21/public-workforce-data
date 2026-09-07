import type { SqlClient } from '@public-workforce/database';
import { QueryRepository, type CoverageSummary } from '@public-workforce/database';

export interface RunSummaryRow {
  id: string;
  runType: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  pagesFetched: number;
  recordsExtracted: number;
  errors: number;
}

export interface FailureRow {
  errorType: string;
  count: number;
  exampleUrl: string | null;
  exampleMessage: string;
}

export interface SourcePolicyQueueRow {
  domain: string | null;
  urlPattern: string | null;
  status: string;
  lastReviewedAt: string | null;
}

export interface DataQualitySample {
  fullNamePublished: string;
  titlePublished: string | null;
  titleNormalized: string | null;
  roleCategory: string;
  organizationName: string | null;
  governmentLevelCode: string;
  emailClassification: string | null;
  sourceUrl: string | null;
  confidence: number;
}

export interface OrganizationSpineSummary {
  stagedSourceRows: number;
  readyToImport: number;
  importedSourceRows: number;
  classificationHolds: number;
  overlayHolds: number;
  reconciliationHolds: number;
  organizations: number;
  publishedWebsites: number;
  missingWebsites: number;
  geographicAreas: number;
  governmentLevels: number;
  sectors: number;
  states: number;
  proposedWebsiteCandidates: number;
  verifiedWebsiteCandidates: number;
  identityReviews: number;
}

/**
 * Read-only views for the internal admin surface.
 *
 * Scoped to what an operator needs to answer "did this run work, and is the
 * data any good": runs, failures, coverage and a sample they can eyeball
 * against the source page. The richer dashboard is in docs/BACKLOG.md.
 */
export class AdminReports {
  private readonly queries: QueryRepository;

  constructor(private readonly client: SqlClient) {
    this.queries = new QueryRepository(client);
  }

  async recentRuns(limit = 20): Promise<RunSummaryRow[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `select id, run_type, status, started_at, finished_at, stats
       from crawl_runs order by started_at desc limit $1`,
      [limit],
    );
    return result.rows.map((row) => {
      const stats = (
        typeof row['stats'] === 'string' ? JSON.parse(row['stats']) : row['stats']
      ) as Record<string, number>;
      return {
        id: String(row['id']),
        runType: String(row['run_type']),
        status: String(row['status']),
        startedAt: iso(row['started_at']),
        finishedAt: row['finished_at'] == null ? null : iso(row['finished_at']),
        pagesFetched: Number(stats?.['pagesFetched'] ?? 0),
        recordsExtracted: Number(stats?.['recordsExtracted'] ?? 0),
        errors: Number(stats?.['errors'] ?? 0),
      };
    });
  }

  /** Failures grouped by kind, so an operator sees the pattern not the noise. */
  async failureBreakdown(crawlRunId?: string): Promise<FailureRow[]> {
    const where = crawlRunId === undefined ? '' : 'where crawl_run_id = $1';
    const params = crawlRunId === undefined ? [] : [crawlRunId];
    const result = await this.client.query<Record<string, unknown>>(
      `select error_type, count(*)::int as count,
              (array_agg(url order by occurred_at desc))[1] as example_url,
              (array_agg(message order by occurred_at desc))[1] as example_message
       from crawl_errors ${where}
       group by error_type order by count desc`,
      params,
    );
    return result.rows.map((row) => ({
      errorType: String(row['error_type']),
      count: Number(row['count']),
      exampleUrl: (row['example_url'] as string | null) ?? null,
      exampleMessage: typeof row['example_message'] === 'string' ? row['example_message'] : '',
    }));
  }

  async coverage(
    scope: { governmentLevelCode?: string; sectorCode?: string } = {},
  ): Promise<CoverageSummary> {
    return this.queries.coverageSummary(scope);
  }

  /** How many organizations sit at each level of government. */
  async organizationBreakdown(): Promise<
    { governmentLevelCode: string; organizationTypeCode: string; count: number }[]
  > {
    const result = await this.client.query<Record<string, unknown>>(
      `select government_level_code, organization_type_code, count(*)::int as count
       from organizations
       group by government_level_code, organization_type_code
       order by count desc`,
    );
    return result.rows.map((row) => ({
      governmentLevelCode: String(row['government_level_code']),
      organizationTypeCode: String(row['organization_type_code']),
      count: Number(row['count']),
    }));
  }

  /** Canonical coverage already loaded into the database used by this console. */
  async organizationSpineSummary(): Promise<OrganizationSpineSummary> {
    const result = await this.client.query<Record<string, unknown>>(
      `select
         count(*) filter (where o.status = 'active')::int as organizations,
         count(*) filter (where o.status = 'active' and o.website_url is not null)::int
           as published_websites,
         count(*) filter (where o.status = 'active' and o.website_url is null)::int
           as missing_websites,
         count(distinct o.government_level_code) filter (where o.status = 'active')::int
           as government_levels,
         count(distinct o.sector_code) filter (where o.status = 'active')::int as sectors,
         count(*) filter (where o.status = 'active' and o.needs_identity_review)::int
           as identity_reviews,
         (select count(*)::int from geographic_areas) as geographic_areas,
         (select count(distinct state_code)::int from organization_locations
            where state_code is not null) as states,
         (select count(*) filter (where status = 'proposed')::int
            from organization_website_candidates) as proposed_website_candidates,
         (select count(*) filter (where status = 'verified')::int
            from organization_website_candidates) as verified_website_candidates,
         (select count(*)::int from organization_spine_records) as staged_source_rows,
         (select count(*) filter (where status = 'ready_to_import')::int
            from organization_spine_records) as ready_to_import,
         (select count(*) filter (where status = 'imported')::int
            from organization_spine_records) as imported_source_rows,
         (select count(*) filter (where status = 'classification_hold')::int
            from organization_spine_records) as classification_holds,
         (select count(*) filter (where status = 'overlay_hold')::int
            from organization_spine_records) as overlay_holds,
         (select count(*) filter (where status = 'reconciliation_hold')::int
            from organization_spine_records) as reconciliation_holds
       from organizations o`,
    );
    const row = result.rows[0] ?? {};
    return {
      stagedSourceRows: Number(row['staged_source_rows'] ?? 0),
      readyToImport: Number(row['ready_to_import'] ?? 0),
      importedSourceRows: Number(row['imported_source_rows'] ?? 0),
      classificationHolds: Number(row['classification_holds'] ?? 0),
      overlayHolds: Number(row['overlay_holds'] ?? 0),
      reconciliationHolds: Number(row['reconciliation_holds'] ?? 0),
      organizations: Number(row['organizations'] ?? 0),
      publishedWebsites: Number(row['published_websites'] ?? 0),
      missingWebsites: Number(row['missing_websites'] ?? 0),
      geographicAreas: Number(row['geographic_areas'] ?? 0),
      governmentLevels: Number(row['government_levels'] ?? 0),
      sectors: Number(row['sectors'] ?? 0),
      states: Number(row['states'] ?? 0),
      proposedWebsiteCandidates: Number(row['proposed_website_candidates'] ?? 0),
      verifiedWebsiteCandidates: Number(row['verified_website_candidates'] ?? 0),
      identityReviews: Number(row['identity_reviews'] ?? 0),
    };
  }

  /** Sources a person still has to review before production collection. */
  async sourcePolicyQueue(limit = 25): Promise<SourcePolicyQueueRow[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `select domain, url_pattern, collection_status, last_reviewed_at
       from source_policies
       where collection_status in ('review_required','unknown') and production_approved_by is null
       order by created_at limit $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      domain: (row['domain'] as string | null) ?? null,
      urlPattern: (row['url_pattern'] as string | null) ?? null,
      status: String(row['collection_status']),
      lastReviewedAt: row['last_reviewed_at'] == null ? null : iso(row['last_reviewed_at']),
    }));
  }

  /** A sample for eyeballing against the source document. */
  async dataQualitySample(limit = 10): Promise<DataQualitySample[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `select p.full_name_published, emp.title_published, emp.title_normalized,
              emp.role_category_code as role_category, o.name as organization_name,
              o.government_level_code, ea.classification as email_classification,
              sd.url as source_url, emp.confidence
       from people p
       join employment_assignments emp on emp.person_id = p.id
       join organizations o on o.id = emp.organization_id
       left join email_addresses ea on ea.person_id = p.id
       left join source_documents sd on sd.id = emp.source_document_id
       order by emp.confidence asc, p.id
       limit $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      fullNamePublished: String(row['full_name_published']),
      titlePublished: (row['title_published'] as string | null) ?? null,
      titleNormalized: (row['title_normalized'] as string | null) ?? null,
      roleCategory: String(row['role_category']),
      organizationName: (row['organization_name'] as string | null) ?? null,
      governmentLevelCode: (row['government_level_code'] as string | null) ?? 'unknown',
      emailClassification: (row['email_classification'] as string | null) ?? null,
      sourceUrl: (row['source_url'] as string | null) ?? null,
      confidence: Number(row['confidence'] ?? 0),
    }));
  }

  /** Titles the taxonomy did not recognize, so the vocabulary can be grown. */
  async unmatchedTitles(limit = 25): Promise<{ title: string; count: number }[]> {
    const result = await this.client.query<{ title_published: string; count: number }>(
      `select emp.title_published, count(*)::int as count
       from employment_assignments emp
       where emp.role_category_code in ('other', 'unknown') and emp.title_published is not null
       group by emp.title_published order by count desc limit $1`,
      [limit],
    );
    return result.rows.map((row) => ({ title: row.title_published, count: Number(row.count) }));
  }
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
