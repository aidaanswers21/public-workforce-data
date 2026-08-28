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

export interface DataQualitySample {
  fullNamePublished: string;
  titlePublished: string | null;
  titleNormalized: string | null;
  roleCategory: string;
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

  async coverage(stateCode: string): Promise<CoverageSummary> {
    return this.queries.coverageSummary(stateCode);
  }

  /** A random sample for eyeballing against the source page. */
  async dataQualitySample(stateCode: string, limit = 10): Promise<DataQualitySample[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `select p.full_name_published, emp.title_published, emp.title_normalized, emp.role_category,
              ea.classification as email_classification, sp.url as source_url, emp.confidence
       from people p
       join states s on s.id = p.state_id
       join employment_assignments emp on emp.person_id = p.id
       left join email_addresses ea on ea.person_id = p.id
       left join source_pages sp on sp.id = emp.source_page_id
       where s.code = $1
       order by emp.confidence asc, p.id
       limit $2`,
      [stateCode.toUpperCase(), limit],
    );
    return result.rows.map((row) => ({
      fullNamePublished: String(row['full_name_published']),
      titlePublished: (row['title_published'] as string | null) ?? null,
      titleNormalized: (row['title_normalized'] as string | null) ?? null,
      roleCategory: String(row['role_category']),
      emailClassification: (row['email_classification'] as string | null) ?? null,
      sourceUrl: (row['source_url'] as string | null) ?? null,
      confidence: Number(row['confidence'] ?? 0),
    }));
  }

  /** Titles the rule table did not recognize, so the vocabulary can be grown. */
  async unmatchedTitles(
    stateCode: string,
    limit = 25,
  ): Promise<{ title: string; count: number }[]> {
    const result = await this.client.query<{ title_published: string; count: number }>(
      `select emp.title_published, count(*)::int as count
       from employment_assignments emp
       join people p on p.id = emp.person_id
       join states s on s.id = p.state_id
       where s.code = $1 and emp.role_category in ('other','unknown') and emp.title_published is not null
       group by emp.title_published order by count desc limit $2`,
      [stateCode.toUpperCase(), limit],
    );
    return result.rows.map((row) => ({ title: row.title_published, count: Number(row.count) }));
  }
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
