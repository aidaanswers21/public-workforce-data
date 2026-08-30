import type {
  CrawlErrorType,
  CrawlPageStatus,
  CrawlRunStatus,
  CrawlStopReason,
  CrawlTargetStatus,
  CrawlTargetType,
  Uuid,
  Timestamp,
} from './index.js';

/** A page as returned by a fetcher. Transport agnostic on purpose. */
export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
  contentType: string | null;
  fetchedAt: Timestamp;
  /** sha256 of the normalized body. Drives duplicate-content detection. */
  contentHash: string;
  /** True when served from the fixture store or an archived response. */
  fromCache: boolean;
}

export interface FetchRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Hint only. A fetcher may ignore it; the engine decides the real policy. */
  timeoutMs?: number;
}

export interface FetchFailure {
  url: string;
  errorType: CrawlErrorType;
  message: string;
  status?: number;
  retryable: boolean;
}

export type FetchOutcome = { ok: true; page: FetchedPage } | { ok: false; failure: FetchFailure };

export interface Fetcher {
  readonly key: string;
  fetch(request: FetchRequest): Promise<FetchOutcome>;
}

export interface RobotsDecision {
  allowed: boolean;
  /** The matching rule, kept for the policy log. */
  matchedRule: string | null;
  crawlDelaySeconds: number | null;
  note: string | null;
}

export interface RobotsProvider {
  check(url: string, userAgent: string): Promise<RobotsDecision>;
}

export interface CrawlRunRecord {
  id: Uuid;
  jurisdictionId: Uuid | null;
  runType: string;
  status: CrawlRunStatus;
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
  config: Record<string, unknown>;
  stats: CrawlRunStats;
  initiatedBy: string;
}

export interface CrawlRunStats {
  pagesFetched: number;
  pagesSkipped: number;
  pagesFailed: number;
  recordsExtracted: number;
  recordsNew: number;
  recordsUpdated: number;
  errors: number;
  bytesFetched: number;
  durationMs: number;
}

export interface CrawlTargetRecord {
  id: Uuid;
  /** The organization this target belongs to. No state is required or implied. */
  organizationId: Uuid | null;
  jurisdictionId: Uuid | null;
  url: string;
  urlHash: string;
  targetType: CrawlTargetType;
  /** Reference code from the taxonomy. */
  sourceTypeCode: string;
  directoryPlatformId: Uuid | null;
  adapterKey: string | null;
  status: CrawlTargetStatus;
  priority: number;
  exclusionReason: string | null;
  lastCrawledAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CrawlPageRecord {
  id: Uuid;
  crawlRunId: Uuid;
  crawlTargetId: Uuid | null;
  url: string;
  urlHash: string;
  status: CrawlPageStatus;
  httpStatus: number | null;
  depth: number;
  paginationToken: string | null;
  recordsExtracted: number;
  contentHash: string | null;
  durationMs: number | null;
  fetchedAt: Timestamp | null;
}

export interface CrawlErrorRecord {
  id: Uuid;
  crawlRunId: Uuid;
  crawlTargetId: Uuid | null;
  url: string | null;
  errorType: CrawlErrorType;
  message: string;
  retryable: boolean;
  attempt: number;
  occurredAt: Timestamp;
}

/** Serializable resume point. Written after every page so a run can restart mid-directory. */
export interface CrawlCheckpoint {
  crawlRunId: Uuid;
  crawlTargetId: Uuid | null;
  /** Tasks not yet attempted, in deterministic order. */
  pendingTasks: readonly CrawlTaskSnapshot[];
  visitedUrlHashes: readonly string[];
  seenContentHashes: readonly string[];
  seenRecordKeys: readonly string[];
  pagesFetched: number;
  updatedAt: Timestamp;
}

export interface CrawlTaskSnapshot {
  url: string;
  kind: 'listing' | 'profile' | 'discovery';
  depth: number;
  adapterKey: string | null;
  paginationToken: string | null;
  context: Record<string, unknown>;
}

export interface CrawlStopSignal {
  reason: CrawlStopReason;
  detail: string;
  url: string | null;
}
