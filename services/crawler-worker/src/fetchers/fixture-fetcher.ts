import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { FetchOutcome, FetchRequest, Fetcher } from '@pan/shared-types';
import { canonicalizeUrl, contentHash } from '@pan/core';

export interface FixtureRoute {
  url: string;
  filePath: string;
  contentType?: string;
  status?: number;
}

/**
 * Serves saved fixtures instead of making requests.
 *
 * This is what `pnpm crawl:fixture` and the end-to-end test run against. It
 * exists so the full pipeline, right through to a written CSV, can be exercised
 * with no network access at all, which is both a testing property and an
 * operational one: nothing in this repository can accidentally crawl a real
 * district while someone is developing against it.
 */
export class FixtureFetcher implements Fetcher {
  readonly key = 'fixture';
  readonly requested: string[] = [];
  private readonly routes = new Map<string, FixtureRoute>();

  constructor(routes: readonly FixtureRoute[]) {
    for (const route of routes) {
      const canonical = canonicalizeUrl(route.url);
      if (canonical === null) throw new Error(`FixtureFetcher: unusable route url ${route.url}`);
      this.routes.set(canonical, route);
    }
  }

  fetch(request: FetchRequest): Promise<FetchOutcome> {
    const canonical = canonicalizeUrl(request.url) ?? request.url;
    this.requested.push(canonical);
    const route = this.routes.get(canonical);

    if (route === undefined) {
      return Promise.resolve({
        ok: false,
        failure: {
          url: canonical,
          errorType: 'http_error',
          message: 'no fixture is registered for this url',
          status: 404,
          retryable: false,
        },
      });
    }

    const body = readFileSync(route.filePath, 'utf8');
    const contentType =
      route.contentType ??
      (extname(route.filePath) === '.json' ? 'application/json' : 'text/html; charset=utf-8');

    return Promise.resolve({
      ok: true,
      page: {
        url: canonical,
        finalUrl: canonical,
        status: route.status ?? 200,
        headers: { 'content-type': contentType },
        body,
        contentType,
        fetchedAt: new Date().toISOString(),
        contentHash: contentHash(body),
        fromCache: true,
      },
    });
  }
}
