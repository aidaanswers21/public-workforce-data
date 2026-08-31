import type { CrawlStopReason, CrawlStopSignal } from '@public-workforce/shared-types';
import { registrableDomain } from '../normalize/urls.js';
import type { CrawlPolicy } from './policy.js';

export interface GuardVerdict {
  allowed: boolean;
  stop: CrawlStopSignal | null;
  /** Set when this one URL is skipped but the run continues. */
  skipReason: string | null;
}

const CONTINUE: GuardVerdict = { allowed: true, stop: null, skipReason: null };

function skip(reason: string): GuardVerdict {
  return { allowed: false, stop: null, skipReason: reason };
}

function halt(reason: CrawlStopReason, detail: string, url: string | null): GuardVerdict {
  return { allowed: false, stop: { reason, detail, url }, skipReason: null };
}

/**
 * All the ways a directory crawl can go wrong, in one place.
 *
 * The engine consults this before every fetch and after every extraction. State
 * lives here rather than in the engine so that a run can be resumed from a
 * checkpoint by replaying the sets, and so the guards can be tested on their own.
 */
export class CrawlGuards {
  private readonly visitedUrlHashes = new Set<string>();
  private readonly seenContentHashes = new Set<string>();
  private readonly seenRecordKeys = new Set<string>();
  private readonly seenPaginationTokens = new Set<string>();
  private readonly pagesPerDomain = new Map<string, number>();
  private readonly consecutiveFailuresPerDomain = new Map<string, number>();
  private pagesFetched = 0;
  private pagesWithoutNewRecords = 0;
  private readonly stops: CrawlStopSignal[] = [];

  constructor(private readonly policy: CrawlPolicy) {}

  /** Rehydrate from a checkpoint so a resumed run does not redo finished work. */
  restore(snapshot: {
    visitedUrlHashes?: readonly string[];
    seenContentHashes?: readonly string[];
    seenRecordKeys?: readonly string[];
    pagesFetched?: number;
  }): void {
    for (const hash of snapshot.visitedUrlHashes ?? []) this.visitedUrlHashes.add(hash);
    for (const hash of snapshot.seenContentHashes ?? []) this.seenContentHashes.add(hash);
    for (const key of snapshot.seenRecordKeys ?? []) this.seenRecordKeys.add(key);
    this.pagesFetched = snapshot.pagesFetched ?? 0;
  }

  /** Checked before a URL is fetched. */
  beforeFetch(input: { url: string; urlHash: string; depth: number }): GuardVerdict {
    if (this.pagesFetched >= this.policy.maxPagesPerRun) {
      return halt(
        'page_budget_exhausted',
        `run budget of ${this.policy.maxPagesPerRun} pages reached`,
        input.url,
      );
    }
    if (input.depth > this.policy.maxDepth) {
      return skip(`depth ${input.depth} exceeds max depth ${this.policy.maxDepth}`);
    }
    if (this.visitedUrlHashes.has(input.urlHash)) {
      return skip('url already visited in this run');
    }
    const domain = domainKey(input.url, this.policy.localityDomainLabels);
    const domainPages = this.pagesPerDomain.get(domain) ?? 0;
    if (domainPages >= this.policy.maxPagesPerDomain) {
      return halt(
        'domain_budget_exhausted',
        `domain ${domain} reached its ${this.policy.maxPagesPerDomain} page budget`,
        input.url,
      );
    }
    const failures = this.consecutiveFailuresPerDomain.get(domain) ?? 0;
    if (failures >= this.policy.maxConsecutiveFailuresPerDomain) {
      return halt(
        'repeated_failures',
        `domain ${domain} failed ${failures} times consecutively`,
        input.url,
      );
    }
    for (const pattern of this.policy.excludedUrlPatterns) {
      if (pattern.test(input.url)) return skip(`excluded by pattern ${pattern.source}`);
    }
    return CONTINUE;
  }

  /** Called once a fetch succeeds, before extraction. */
  afterFetch(input: { url: string; urlHash: string; contentHash: string }): GuardVerdict {
    this.visitedUrlHashes.add(input.urlHash);
    this.pagesFetched += 1;
    const domain = domainKey(input.url, this.policy.localityDomainLabels);
    this.pagesPerDomain.set(domain, (this.pagesPerDomain.get(domain) ?? 0) + 1);
    this.consecutiveFailuresPerDomain.set(domain, 0);

    if (this.seenContentHashes.has(input.contentHash)) {
      return {
        allowed: false,
        stop: {
          reason: 'duplicate_content',
          detail: 'page body is identical to one already fetched in this run',
          url: input.url,
        },
        skipReason: null,
      };
    }
    this.seenContentHashes.add(input.contentHash);
    return CONTINUE;
  }

  recordFailure(url: string): void {
    const domain = domainKey(url, this.policy.localityDomainLabels);
    this.consecutiveFailuresPerDomain.set(
      domain,
      (this.consecutiveFailuresPerDomain.get(domain) ?? 0) + 1,
    );
  }

  /**
   * Called after extraction. Counts genuinely new record keys, so a directory
   * that keeps serving the same roster under different page numbers stops
   * instead of paginating forever.
   */
  afterExtraction(input: {
    url: string;
    recordKeys: readonly string[];
    empty: boolean;
    isFirstPage: boolean;
  }): { newRecordKeys: string[]; verdict: GuardVerdict } {
    const newRecordKeys = input.recordKeys.filter((key) => !this.seenRecordKeys.has(key));
    for (const key of newRecordKeys) this.seenRecordKeys.add(key);

    if (input.empty && input.isFirstPage) {
      return {
        newRecordKeys,
        verdict: {
          allowed: false,
          stop: {
            reason: 'empty_success',
            detail: 'page fetched successfully but the adapter found no records',
            url: input.url,
          },
          skipReason: null,
        },
      };
    }

    if (newRecordKeys.length === 0) {
      this.pagesWithoutNewRecords += 1;
      if (this.pagesWithoutNewRecords >= this.policy.maxPagesWithoutNewRecords) {
        return {
          newRecordKeys,
          verdict: {
            allowed: false,
            stop: {
              reason: 'no_progress',
              detail: `${this.pagesWithoutNewRecords} consecutive pages produced no new records`,
              url: input.url,
            },
            skipReason: null,
          },
        };
      }
    } else {
      this.pagesWithoutNewRecords = 0;
    }

    return { newRecordKeys, verdict: CONTINUE };
  }

  /**
   * Pagination tokens must be unique within a run.
   *
   * This is the primary loop guard: a directory whose "next" link eventually
   * points back to page 1 is caught here even when the URL differs, because the
   * adapter derives the token from the page identity rather than the raw href.
   */
  claimPaginationToken(token: string, url: string): GuardVerdict {
    if (this.seenPaginationTokens.has(token)) {
      return halt('pagination_loop', `pagination token "${token}" was already followed`, url);
    }
    this.seenPaginationTokens.add(token);
    return CONTINUE;
  }

  noteStop(signal: CrawlStopSignal): void {
    this.stops.push(signal);
  }

  get stopSignals(): readonly CrawlStopSignal[] {
    return this.stops;
  }

  get counters(): {
    pagesFetched: number;
    visitedUrlHashes: string[];
    seenContentHashes: string[];
    seenRecordKeys: string[];
  } {
    return {
      pagesFetched: this.pagesFetched,
      visitedUrlHashes: [...this.visitedUrlHashes],
      seenContentHashes: [...this.seenContentHashes],
      seenRecordKeys: [...this.seenRecordKeys],
    };
  }
}

function domainKey(url: string, localityLabels: readonly string[]): string {
  try {
    return registrableDomain(new URL(url).hostname, localityLabels);
  } catch {
    return 'invalid';
  }
}
