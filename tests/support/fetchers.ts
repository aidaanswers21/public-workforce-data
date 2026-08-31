import type {
  FetchOutcome,
  FetchRequest,
  Fetcher,
  RobotsDecision,
  RobotsProvider,
} from '@public-workforce/shared-types';
import { canonicalizeUrl, contentHash } from '@public-workforce/core';

export interface MapEntry {
  body: string;
  status?: number;
  contentType?: string;
}

/**
 * Serves pages from an in-memory map. No network, no timing.
 *
 * Records every URL requested so tests can assert on what the engine did and,
 * just as importantly, on what it declined to fetch.
 */
export class MapFetcher implements Fetcher {
  readonly key = 'map';
  readonly requested: string[] = [];
  private readonly failures = new Map<
    string,
    { count: number; remaining: number; status?: number; retryable: boolean }
  >();

  constructor(private readonly pages: Map<string, MapEntry>) {}

  static from(entries: Record<string, string | MapEntry>): MapFetcher {
    const pages = new Map<string, MapEntry>();
    for (const [url, value] of Object.entries(entries)) {
      const canonical = canonicalizeUrl(url) ?? url;
      pages.set(canonical, typeof value === 'string' ? { body: value } : value);
    }
    return new MapFetcher(pages);
  }

  /** Fail this URL `times` times before serving it normally. */
  failTimes(
    url: string,
    times: number,
    options: { status?: number; retryable?: boolean } = {},
  ): this {
    const canonical = canonicalizeUrl(url) ?? url;
    this.failures.set(canonical, {
      count: 0,
      remaining: times,
      retryable: options.retryable ?? true,
      ...(options.status === undefined ? {} : { status: options.status }),
    });
    return this;
  }

  fetch(request: FetchRequest): Promise<FetchOutcome> {
    const canonical = canonicalizeUrl(request.url) ?? request.url;
    this.requested.push(canonical);

    const failure = this.failures.get(canonical);
    if (failure !== undefined && failure.remaining > 0) {
      failure.remaining -= 1;
      failure.count += 1;
      return Promise.resolve({
        ok: false,
        failure: {
          url: canonical,
          errorType: failure.status === undefined ? 'network' : 'http_error',
          message:
            failure.status === undefined
              ? 'simulated connection reset'
              : `simulated HTTP ${failure.status}`,
          retryable: failure.retryable,
          ...(failure.status === undefined ? {} : { status: failure.status }),
        },
      });
    }

    const entry = this.pages.get(canonical);
    if (entry === undefined) {
      return Promise.resolve({
        ok: false,
        failure: {
          url: canonical,
          errorType: 'http_error',
          message: 'not found in fixture map',
          status: 404,
          retryable: false,
        },
      });
    }

    return Promise.resolve({
      ok: true,
      page: {
        url: canonical,
        finalUrl: canonical,
        status: entry.status ?? 200,
        headers: { 'content-type': entry.contentType ?? 'text/html; charset=utf-8' },
        body: entry.body,
        contentType: entry.contentType ?? 'text/html',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        contentHash: contentHash(entry.body),
        fromCache: true,
      },
    });
  }
}

/** Disallows any path matching one of the given prefixes. */
export class StubRobotsProvider implements RobotsProvider {
  constructor(private readonly disallowedPrefixes: readonly string[] = []) {}

  check(url: string): Promise<RobotsDecision> {
    const path = new URL(url).pathname;
    const matched = this.disallowedPrefixes.find((prefix) => path.startsWith(prefix));
    return Promise.resolve(
      matched === undefined
        ? { allowed: true, matchedRule: null, crawlDelaySeconds: null, note: null }
        : {
            allowed: false,
            matchedRule: `Disallow: ${matched}`,
            crawlDelaySeconds: null,
            note: null,
          },
    );
  }
}

/** A sleep that records what it was asked to wait for without waiting. */
export function recordingSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}
