import type {
  CrawlCheckpoint,
  DirectoryVocabulary,
  CrawlErrorRecord,
  CrawlErrorType,
  CrawlPageRecord,
  CrawlRunStats,
  CrawlStopSignal,
  CrawlTaskSnapshot,
  DirectoryAdapter,
  ExtractedPersonRecord,
  FetchedPage,
  Fetcher,
  PaginationRequest,
  RobotsDecision,
  RobotsProvider,
  Timestamp,
  Uuid,
} from '@public-workforce/shared-types';
import type { Logger } from '@public-workforce/observability';
import { canonicalizeUrl, registrableDomain, resolveUrl } from '../normalize/urls.js';
import { dedupeExtractedRecords } from '../dedup.js';
import { sha256, shortHash, stableStringify } from '../hash.js';
import { newUuid, urlHash } from '../ids.js';
import { type Clock, nowTimestamp, systemClock } from '../time.js';
import { CrawlGuards } from './guards.js';
import { isAllowedDomain, type CrawlPolicy } from './policy.js';
import { applyDataBoundary } from '../policy/data-boundary.js';
import { SourcePolicyRegistry, type CollectionMode } from '../policy/source-policy.js';

export type TaskKind = 'listing' | 'profile' | 'discovery';

interface CrawlTask {
  url: string;
  kind: TaskKind;
  depth: number;
  paginationToken: string | null;
  context: Record<string, unknown>;
  request?: PaginationRequest;
}

/** One person record together with the page it came from. */
export interface HarvestedRecord {
  record: ExtractedPersonRecord;
  sourceUrl: string;
  sourceContentHash: string;
  fetchedAt: Timestamp;
  httpStatus: number;
  contentType: string | null;
  /** Null means robots was deliberately not consulted, as in fixture mode. */
  robotsAllowed: boolean | null;
  robotsPolicyNote: string | null;
  depth: number;
  /** Directory-wide context established by the page, such as organization or unit. */
  pageContext: Readonly<Record<string, string>>;
}

export interface CrawlJob {
  crawlRunId: Uuid;
  crawlTargetId: Uuid | null;
  seedUrl: string;
  adapter: DirectoryAdapter;
  policy: CrawlPolicy;
  /** Terms composed from the registered sectors. Adapters read this, not constants. */
  vocabulary: DirectoryVocabulary;
  /** The organization whose directory this is, when known. */
  organizationName?: string | null;
  /** The organization above it, when there is one. Never required. */
  parentOrganizationName?: string | null;
  /**
   * Whether this run actually collects. A fixture run reads saved files, so the
   * source-policy gate does not apply to it.
   */
  collectionMode?: CollectionMode;
  /** Consulted before every fetch in a production run. */
  sourcePolicy?: SourcePolicyRegistry;
  /** Follow links to individual profile pages when the listing exposes them. */
  followProfiles?: boolean;
  resumeFrom?: CrawlCheckpoint;
}

export interface CrawlRunResult {
  crawlRunId: Uuid;
  seedUrl: string;
  adapterKey: string;
  adapterVersion: string;
  pages: CrawlPageRecord[];
  records: HarvestedRecord[];
  errors: CrawlErrorRecord[];
  stops: CrawlStopSignal[];
  stats: CrawlRunStats;
  checkpoint: CrawlCheckpoint;
}

export interface CrawlEngineDeps {
  fetcher: Fetcher;
  robots: RobotsProvider;
  logger: Logger;
  clock?: Clock;
  /** Injectable so tests do not spend real time honouring the crawl delay. */
  sleep?: (milliseconds: number) => Promise<void>;
  onCheckpoint?: (checkpoint: CrawlCheckpoint) => Promise<void> | void;
}

/**
 * Pagination kinds that walk a sequence and must never revisit a page.
 *
 * Numbered pagers and filter lists legitimately link backwards ("1 2 3" on
 * every page), so a repeat there is a duplicate to skip. A repeat on a
 * sequential walk is a genuine cycle and stops the run.
 */
const SEQUENTIAL_PAGINATION_KINDS: ReadonlySet<string> = new Set([
  'next_link',
  'cursor_api',
  'load_more',
  'infinite_scroll',
  'offset_param',
  'page_param',
]);

const CAPTCHA_MARKERS =
  /(g-recaptcha|hcaptcha|cf-challenge|challenge-platform|are you a robot|verify you are human)/i;

/**
 * Walks one directory target and returns the people it published.
 *
 * The engine owns everything that must not vary between platforms: budgets,
 * rate limiting, robots, retries, loop protection, checkpointing and
 * provenance. Adapters only answer "what is on this page" and "where is the
 * next one", which is why adding a state or a platform never touches this file.
 */
export class CrawlEngine {
  private readonly clock: Clock;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly deps: CrawlEngineDeps) {
    this.clock = deps.clock ?? systemClock;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async run(job: CrawlJob): Promise<CrawlRunResult> {
    const startedAt = this.clock().getTime();
    const guards = new CrawlGuards(job.policy);
    const pages: CrawlPageRecord[] = [];
    const errors: CrawlErrorRecord[] = [];
    const harvested: HarvestedRecord[] = [];
    const log = this.deps.logger.child({ crawlRunId: job.crawlRunId, adapter: job.adapter.key });

    const seed = canonicalizeUrl(job.seedUrl);
    if (seed === null) {
      throw new Error(`CrawlEngine: seed url is not a usable http(s) url: ${job.seedUrl}`);
    }

    const queue: CrawlTask[] = [];
    if (job.resumeFrom !== undefined) {
      guards.restore(job.resumeFrom);
      for (const snapshot of job.resumeFrom.pendingTasks) {
        queue.push({
          url: snapshot.url,
          kind: snapshot.kind,
          depth: snapshot.depth,
          paginationToken: snapshot.paginationToken,
          context: snapshot.context,
          ...(snapshot.paginationRequest == null
            ? {}
            : {
                request: {
                  url: snapshot.url,
                  token: snapshot.paginationToken ?? snapshot.url,
                  context: snapshot.context,
                  ...snapshot.paginationRequest,
                },
              }),
        });
      }
      log.info({ pendingTasks: queue.length }, 'resumed crawl from checkpoint');
    } else {
      queue.push({ url: seed, kind: 'listing', depth: 0, paginationToken: null, context: {} });
      guards.claimPaginationToken(paginationToken(seed, undefined), seed);
    }

    let bytesFetched = 0;
    let lastRequestAtByDomain = new Map<string, number>();
    let isFirstPage = job.resumeFrom === undefined;

    while (queue.length > 0) {
      const task = queue.shift();
      if (task === undefined) break;

      const hash = urlHash(task.url);
      const before = guards.beforeFetch({ url: task.url, urlHash: hash, depth: task.depth });
      if (before.stop !== null) {
        // The budget stopped before any request. Keep this task at the front so
        // a later, explicitly enlarged batch can resume without losing a page.
        queue.unshift(task);
        guards.noteStop(before.stop);
        log.warn({ stop: before.stop }, 'crawl halted by guard');
        break;
      }
      if (!before.allowed) {
        pages.push(
          this.pageRecord(job, task, { status: 'skipped', note: before.skipReason ?? 'skipped' }),
        );
        continue;
      }

      if (!isAllowedDomain(task.url, seed, job.policy)) {
        pages.push(
          this.pageRecord(job, task, {
            status: 'skipped',
            note: 'cross-domain navigation refused',
          }),
        );
        log.debug({ url: task.url }, 'refused cross-domain navigation');
        continue;
      }

      const collectionMode: CollectionMode = job.collectionMode ?? 'production';
      const sourcePolicy = job.sourcePolicy ?? SourcePolicyRegistry.empty();
      const policyDecision = sourcePolicy.evaluate(task.url, collectionMode);
      if (!policyDecision.allowed) {
        errors.push(
          this.errorRecord(job, task.url, 'source_policy_refusal', policyDecision.reason, false, 1),
        );
        pages.push(this.pageRecord(job, task, { status: 'blocked', note: 'source policy' }));
        guards.noteStop({
          reason: 'blocked_by_source_policy',
          detail: policyDecision.reason,
          url: task.url,
        });
        log.warn(
          { url: task.url, status: policyDecision.status, policyId: policyDecision.policyId },
          'source policy refuses collection; stopping this target',
        );
        break;
      }

      let robotsDecision: RobotsDecision | null = null;
      if (job.policy.respectRobots) {
        const decision = await this.deps.robots.check(task.url, job.policy.userAgent);
        robotsDecision = decision;
        if (!decision.allowed) {
          errors.push(
            this.errorRecord(
              job,
              task.url,
              'robots_disallowed',
              `robots.txt disallows this path (${decision.matchedRule ?? 'unspecified rule'})`,
              false,
              1,
            ),
          );
          pages.push(this.pageRecord(job, task, { status: 'blocked', note: 'robots disallowed' }));
          guards.noteStop({
            reason: 'blocked_by_robots',
            detail: decision.matchedRule ?? 'robots.txt disallowed',
            url: task.url,
          });
          log.info(
            { url: task.url, rule: decision.matchedRule },
            'robots disallowed, recording and stopping',
          );
          break;
        }
        if (
          decision.crawlDelaySeconds !== null &&
          decision.crawlDelaySeconds * 1000 > job.policy.requestDelayMs
        ) {
          await this.throttle(
            task.url,
            decision.crawlDelaySeconds * 1000,
            lastRequestAtByDomain,
            job.policy.localityDomainLabels,
          );
        } else {
          await this.throttle(
            task.url,
            job.policy.requestDelayMs,
            lastRequestAtByDomain,
            job.policy.localityDomainLabels,
          );
        }
      } else {
        await this.throttle(
          task.url,
          job.policy.requestDelayMs,
          lastRequestAtByDomain,
          job.policy.localityDomainLabels,
        );
      }

      const fetchStartedAt = this.clock().getTime();
      const outcome = await this.fetchWithRetries(task, job, errors);
      const durationMs = this.clock().getTime() - fetchStartedAt;

      if (outcome === null) {
        guards.recordFailure(task.url);
        pages.push(this.pageRecord(job, task, { status: 'failed', durationMs }));
        continue;
      }

      const page = outcome;
      bytesFetched += page.body.length;

      if (CAPTCHA_MARKERS.test(page.body)) {
        errors.push(
          this.errorRecord(
            job,
            task.url,
            'captcha',
            'source presented a human-verification challenge; stopping rather than attempting to bypass it',
            false,
            1,
          ),
        );
        pages.push(
          this.pageRecord(job, task, {
            status: 'blocked',
            httpStatus: page.status,
            durationMs,
            note: 'captcha',
          }),
        );
        guards.noteStop({
          reason: 'blocked_by_source',
          detail: 'human-verification challenge',
          url: task.url,
        });
        log.warn({ url: task.url }, 'challenge page detected, stopping this target');
        break;
      }

      const after = guards.afterFetch({
        url: task.url,
        urlHash: hash,
        contentHash: page.contentHash,
      });
      if (after.stop !== null) {
        guards.noteStop(after.stop);
        pages.push(
          this.pageRecord(job, task, {
            status: 'skipped',
            httpStatus: page.status,
            durationMs,
            contentHash: page.contentHash,
            note: after.stop.reason,
          }),
        );
        log.info({ stop: after.stop }, 'duplicate content, stopping this branch');
        break;
      }

      const adapterContext = {
        baseUrl: page.finalUrl,
        organizationName: job.organizationName ?? null,
        parentOrganizationName: job.parentOrganizationName ?? null,
        allowedDomains:
          job.policy.allowedDomains.length > 0
            ? job.policy.allowedDomains
            : [registrableDomain(new URL(seed).hostname, job.policy.localityDomainLabels)],
        vocabulary: job.vocabulary,
        now: () => this.clock(),
      };

      let recordsOnPage: ExtractedPersonRecord[] = [];
      let pageContext: Readonly<Record<string, string>> = {};
      let empty = false;
      let pagination: PaginationRequest[] = [];

      try {
        if (task.kind === 'profile') {
          const profile = job.adapter.extractProfile(page, adapterContext);
          recordsOnPage = profile === null ? [] : [profile];
          empty = profile === null;
        } else if (task.kind === 'discovery') {
          for (const discovered of job.adapter.discoverDirectories(page, adapterContext)) {
            const resolved = resolveUrl(discovered.url, page.finalUrl);
            if (resolved === null) continue;
            queue.push({
              url: resolved,
              kind: 'listing',
              depth: task.depth + 1,
              paginationToken: null,
              context: { discoveredScore: discovered.score },
            });
          }
          pages.push(
            this.pageRecord(job, task, {
              status: 'parsed',
              httpStatus: page.status,
              durationMs,
              contentHash: page.contentHash,
            }),
          );
          continue;
        } else {
          const extraction = job.adapter.extractListing(page, adapterContext);
          recordsOnPage = [...extraction.records];
          pageContext = extraction.context;
          empty = extraction.empty;
          pagination = [...extraction.pagination.requests];
          for (const warning of extraction.warnings) {
            log.warn({ url: task.url, warning }, 'adapter warning');
          }
        }
      } catch (error) {
        errors.push(
          this.errorRecord(
            job,
            task.url,
            'adapter_error',
            error instanceof Error ? error.message : String(error),
            false,
            1,
          ),
        );
        pages.push(
          this.pageRecord(job, task, {
            status: 'failed',
            httpStatus: page.status,
            durationMs,
            contentHash: page.contentHash,
          }),
        );
        continue;
      }

      // Checkpoint identity is created only from fields that survived the data
      // boundary. Adapter keys may contain readable names, titles or other raw
      // values, so none of them can enter a persisted resume payload.
      recordsOnPage = dedupeExtractedRecords(
        recordsOnPage.flatMap((record) => {
          const safe = checkpointSafeRecord(record);
          return safe === null ? [] : [safe];
        }),
      );
      if (recordsOnPage.length === 0) empty = true;

      const fingerprints = new Map(
        recordsOnPage.map((record) => [record, record.recordKey] as const),
      );
      const extraction = guards.afterExtraction({
        url: task.url,
        recordKeys: [...fingerprints.values()],
        empty,
        isFirstPage,
      });
      isFirstPage = false;

      const newKeys = new Set(extraction.newRecordKeys);
      for (const record of recordsOnPage) {
        // A person republished on a later page of the same run is recorded once,
        // against the page that first published them.
        if (!newKeys.has(fingerprints.get(record) ?? '')) continue;
        harvested.push({
          record,
          sourceUrl: page.finalUrl,
          sourceContentHash: page.contentHash,
          fetchedAt: page.fetchedAt,
          httpStatus: page.status,
          contentType: page.contentType,
          robotsAllowed: robotsDecision?.allowed ?? null,
          robotsPolicyNote:
            robotsDecision === null ? null : (robotsDecision.note ?? robotsDecision.matchedRule),
          depth: task.depth,
          pageContext,
        });
      }

      pages.push(
        this.pageRecord(job, task, {
          status: 'parsed',
          httpStatus: page.status,
          durationMs,
          contentHash: page.contentHash,
          recordsExtracted: extraction.newRecordKeys.length,
        }),
      );

      if (extraction.verdict.stop !== null) {
        guards.noteStop(extraction.verdict.stop);
        log.info({ stop: extraction.verdict.stop }, 'extraction guard stopped the walk');
        break;
      }

      if (job.followProfiles === true) {
        for (const record of recordsOnPage) {
          if (record.profileUrl === null) continue;
          const resolved = resolveUrl(record.profileUrl, page.finalUrl);
          if (resolved === null) continue;
          queue.push({
            url: resolved,
            kind: 'profile',
            depth: task.depth + 1,
            paginationToken: null,
            context: { recordKey: record.recordKey },
          });
        }
      }

      let loopDetected = false;
      for (const request of pagination) {
        const resolved = resolveUrl(request.url, page.finalUrl);
        if (resolved === null) continue;
        const claim = guards.claimPaginationToken(
          paginationToken(resolved, request.body),
          resolved,
        );
        if (claim.stop !== null) {
          if (SEQUENTIAL_PAGINATION_KINDS.has(request.kind)) {
            guards.noteStop(claim.stop);
            log.info({ stop: claim.stop, kind: request.kind }, 'pagination loop detected');
            loopDetected = true;
            break;
          }
          // A numbered pager or filter list pointing back at a page we already
          // queued. Skip the duplicate and keep walking.
          continue;
        }
        queue.push({
          url: resolved,
          kind: 'listing',
          depth: task.depth,
          paginationToken: request.token,
          context: request.context ?? {},
          request,
        });
      }
      if (loopDetected) break;

      const checkpoint = this.buildCheckpoint(job, queue, guards);
      await this.deps.onCheckpoint?.(checkpoint);
    }

    if (guards.stopSignals.length === 0) {
      guards.noteStop({ reason: 'completed', detail: 'frontier exhausted', url: null });
    }

    const counters = guards.counters;
    const stats: CrawlRunStats = {
      pagesFetched: counters.pagesFetched,
      pagesSkipped: pages.filter((page) => page.status === 'skipped').length,
      pagesFailed: pages.filter((page) => page.status === 'failed').length,
      recordsExtracted: harvested.length,
      recordsNew: harvested.length,
      recordsUpdated: 0,
      errors: errors.length,
      bytesFetched,
      durationMs: this.clock().getTime() - startedAt,
    };

    lastRequestAtByDomain = new Map();

    return {
      crawlRunId: job.crawlRunId,
      seedUrl: seed,
      adapterKey: job.adapter.key,
      adapterVersion: job.adapter.version,
      pages,
      records: harvested,
      errors,
      stops: [...guards.stopSignals],
      stats,
      checkpoint: this.buildCheckpoint(job, queue, guards),
    };
  }

  private async throttle(
    url: string,
    delayMs: number,
    lastRequestAtByDomain: Map<string, number>,
    localityDomainLabels: readonly string[],
  ): Promise<void> {
    if (delayMs <= 0) return;
    let domain: string;
    try {
      domain = registrableDomain(new URL(url).hostname, localityDomainLabels);
    } catch {
      return;
    }
    const last = lastRequestAtByDomain.get(domain);
    const now = this.clock().getTime();
    if (last !== undefined) {
      const elapsed = now - last;
      if (elapsed < delayMs) await this.sleep(delayMs - elapsed);
    }
    lastRequestAtByDomain.set(domain, this.clock().getTime());
  }

  /**
   * Retries only what is worth retrying.
   *
   * 401, 403 and 429 are treated as the source telling us to stop, not as
   * transient noise: retrying them harder is exactly the behaviour that gets a
   * crawler blocked and is not something this platform does.
   */
  private async fetchWithRetries(
    task: CrawlTask,
    job: CrawlJob,
    errors: CrawlErrorRecord[],
  ): Promise<FetchedPage | null> {
    for (let attempt = 1; attempt <= job.policy.maxRetries + 1; attempt += 1) {
      const outcome = await this.deps.fetcher.fetch({
        url: task.url,
        method: task.request?.method ?? 'GET',
        headers: { 'user-agent': job.policy.userAgent, ...(task.request?.headers ?? {}) },
        ...(task.request?.body === undefined ? {} : { body: task.request.body }),
        timeoutMs: job.policy.requestTimeoutMs,
      });

      if (outcome.ok) return outcome.page;

      const { failure } = outcome;
      const terminal = !failure.retryable || attempt > job.policy.maxRetries;
      errors.push(
        this.errorRecord(
          job,
          task.url,
          failure.errorType,
          failure.message,
          failure.retryable,
          attempt,
        ),
      );
      if (terminal) return null;
      await this.sleep(job.policy.retryBaseDelayMs * 2 ** (attempt - 1));
    }
    return null;
  }

  private buildCheckpoint(
    job: CrawlJob,
    queue: readonly CrawlTask[],
    guards: CrawlGuards,
  ): CrawlCheckpoint {
    const counters = guards.counters;
    const pendingTasks: CrawlTaskSnapshot[] = queue.map((task) => ({
      url: task.url,
      kind: task.kind,
      depth: task.depth,
      adapterKey: job.adapter.key,
      paginationToken: task.paginationToken,
      context: task.context,
      paginationRequest:
        task.request === undefined
          ? null
          : {
              kind: task.request.kind,
              ...(task.request.method === undefined ? {} : { method: task.request.method }),
              ...(task.request.body === undefined ? {} : { body: task.request.body }),
              ...(task.request.headers === undefined ? {} : { headers: task.request.headers }),
            },
    }));
    return {
      crawlRunId: job.crawlRunId,
      crawlTargetId: job.crawlTargetId,
      pendingTasks,
      visitedUrlHashes: counters.visitedUrlHashes,
      seenContentHashes: counters.seenContentHashes,
      seenRecordKeys: counters.seenRecordKeys,
      pagesFetched: counters.pagesFetched,
      seenPaginationTokens: counters.seenPaginationTokens,
      pagesPerDomain: counters.pagesPerDomain,
      consecutiveFailuresPerDomain: counters.consecutiveFailuresPerDomain,
      pagesWithoutNewRecords: counters.pagesWithoutNewRecords,
      updatedAt: nowTimestamp(this.clock),
    };
  }

  private pageRecord(
    job: CrawlJob,
    task: CrawlTask,
    fields: {
      status: CrawlPageRecord['status'];
      httpStatus?: number;
      durationMs?: number;
      contentHash?: string;
      recordsExtracted?: number;
      note?: string;
    },
  ): CrawlPageRecord {
    return {
      id: newUuid(),
      crawlRunId: job.crawlRunId,
      crawlTargetId: job.crawlTargetId,
      url: task.url,
      urlHash: urlHash(task.url),
      status: fields.status,
      httpStatus: fields.httpStatus ?? null,
      depth: task.depth,
      paginationToken: task.paginationToken,
      recordsExtracted: fields.recordsExtracted ?? 0,
      contentHash: fields.contentHash ?? null,
      durationMs: fields.durationMs ?? null,
      fetchedAt:
        fields.status === 'parsed' || fields.status === 'fetched' ? nowTimestamp(this.clock) : null,
    };
  }

  private errorRecord(
    job: CrawlJob,
    url: string | null,
    errorType: CrawlErrorType,
    message: string,
    retryable: boolean,
    attempt: number,
  ): CrawlErrorRecord {
    return {
      id: newUuid(),
      crawlRunId: job.crawlRunId,
      crawlTargetId: job.crawlTargetId,
      url,
      errorType,
      message,
      retryable,
      attempt,
      occurredAt: nowTimestamp(this.clock),
    };
  }
}

/**
 * Sanitize a record before assigning the opaque key used by guards and
 * checkpoints. The pipeline applies the same boundary again before database
 * writes, so this is an early privacy barrier rather than a replacement for
 * the ingestion control.
 */
function checkpointSafeRecord(record: ExtractedPersonRecord): ExtractedPersonRecord | null {
  const boundary = applyDataBoundary({
    full_name_published: record.fullNamePublished,
    title_published: record.titlePublished,
    department_published: record.departmentPublished,
    organization_published: record.organizationPublished,
    phone_published: record.phonePublished,
  });
  const fullNamePublished = boundary.allowed['full_name_published'];
  if (fullNamePublished === undefined) return null;

  const safe = {
    ...record,
    fullNamePublished,
    titlePublished: boundary.allowed['title_published'] ?? null,
    departmentPublished: boundary.allowed['department_published'] ?? null,
    organizationPublished: boundary.allowed['organization_published'] ?? null,
    phonePublished: boundary.allowed['phone_published'] ?? null,
  };
  const recordKey = sha256(
    stableStringify({
      fullNamePublished: safe.fullNamePublished,
      titlePublished: safe.titlePublished,
      departmentPublished: safe.departmentPublished,
      organizationPublished: safe.organizationPublished,
      phonePublished: safe.phonePublished,
      profileUrl: safe.profileUrl,
    }),
  );
  return { ...safe, recordKey };
}

/**
 * Identity of a pagination destination.
 *
 * Keyed on the resolved URL so a cycle is caught whatever the link text says,
 * with the request body folded in for APIs that paginate by POSTing a cursor to
 * a single endpoint.
 */
function paginationToken(resolvedUrl: string, body: string | undefined): string {
  return body === undefined || body.length === 0
    ? resolvedUrl
    : `${resolvedUrl}#${shortHash(body, 12)}`;
}
