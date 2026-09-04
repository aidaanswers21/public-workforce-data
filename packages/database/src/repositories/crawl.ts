import type {
  CrawlCheckpoint,
  CrawlErrorRecord,
  CrawlPageRecord,
  CrawlRunStats,
  CrawlRunStatus,
  Timestamp,
  Uuid,
} from '@public-workforce/shared-types';
import type { SqlClient } from '../client.js';

export interface StartRunInput {
  jurisdictionId: Uuid | null;
  runType: string;
  config: Record<string, unknown>;
  initiatedBy: string;
}

/** Crawl bookkeeping: runs, pages, errors and resume points. */
export class CrawlRepository {
  constructor(private readonly client: SqlClient) {}

  async startRun(input: StartRunInput): Promise<Uuid> {
    const result = await this.client.query<{ id: Uuid }>(
      `insert into crawl_runs (jurisdiction_id, run_type, status, config, initiated_by)
       values ($1, $2, 'running', $3, $4) returning id`,
      [input.jurisdictionId, input.runType, JSON.stringify(input.config), input.initiatedBy],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('crawl_runs: insert returned no id');
    return id;
  }

  async finishRun(
    crawlRunId: Uuid,
    status: CrawlRunStatus,
    stats: CrawlRunStats,
    finishedAt: Timestamp,
  ): Promise<void> {
    await this.client.query(
      `update crawl_runs set status = $2, stats = $3, finished_at = $4 where id = $1`,
      [crawlRunId, status, JSON.stringify(stats), finishedAt],
    );
  }

  /** One row per url per run, so a resumed or repeated run rewrites rather than appends. */
  async upsertPage(page: CrawlPageRecord): Promise<void> {
    await this.client.query(
      `insert into crawl_pages (
         crawl_run_id, crawl_target_id, url, url_hash, status, http_status, depth,
         pagination_token, records_extracted, content_hash, duration_ms, fetched_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (crawl_run_id, url_hash) do update set
         status = excluded.status,
         http_status = excluded.http_status,
         records_extracted = excluded.records_extracted,
         content_hash = excluded.content_hash,
         duration_ms = excluded.duration_ms,
         fetched_at = excluded.fetched_at`,
      [
        page.crawlRunId,
        page.crawlTargetId,
        page.url,
        page.urlHash,
        page.status,
        page.httpStatus,
        page.depth,
        page.paginationToken,
        page.recordsExtracted,
        page.contentHash,
        page.durationMs,
        page.fetchedAt,
      ],
    );
  }

  async recordError(error: CrawlErrorRecord): Promise<void> {
    await this.client.query(
      `insert into crawl_errors (crawl_run_id, crawl_target_id, url, error_type, message, retryable, attempt, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        error.crawlRunId,
        error.crawlTargetId,
        error.url,
        error.errorType,
        error.message,
        error.retryable,
        error.attempt,
        error.occurredAt,
      ],
    );
  }

  async saveCheckpoint(checkpoint: CrawlCheckpoint): Promise<void> {
    for (const key of checkpoint.seenRecordKeys) {
      if (!/^[0-9a-f]{64}$/.test(key)) {
        throw new Error('crawl checkpoint record keys must be opaque SHA-256 digests');
      }
    }
    await this.client.query(
      `insert into crawl_checkpoints (crawl_run_id, crawl_target_id, payload, pages_fetched, updated_at)
       values ($1,$2,$3,$4,$5)
       on conflict (crawl_run_id, crawl_target_id) do update set
         payload = excluded.payload,
         pages_fetched = excluded.pages_fetched,
         updated_at = excluded.updated_at`,
      [
        checkpoint.crawlRunId,
        checkpoint.crawlTargetId,
        JSON.stringify(checkpoint),
        checkpoint.pagesFetched,
        checkpoint.updatedAt,
      ],
    );
  }

  async loadCheckpoint(
    crawlRunId: Uuid,
    crawlTargetId: Uuid | null,
  ): Promise<CrawlCheckpoint | null> {
    const result = await this.client.query<{ payload: CrawlCheckpoint | string }>(
      `select payload from crawl_checkpoints
       where crawl_run_id = $1 and crawl_target_id is not distinct from $2`,
      [crawlRunId, crawlTargetId],
    );
    const payload = result.rows[0]?.payload;
    if (payload === undefined) return null;
    return typeof payload === 'string' ? (JSON.parse(payload) as CrawlCheckpoint) : payload;
  }
}
