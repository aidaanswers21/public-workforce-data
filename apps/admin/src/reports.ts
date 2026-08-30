import type { SqlClient } from '@pan/database';
import { QueryRepository, type CoverageSummary } from '@pan/database';

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
