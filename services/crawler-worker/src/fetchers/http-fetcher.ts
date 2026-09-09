import type { FetchOutcome, FetchRequest, Fetcher } from '@public-workforce/shared-types';
import { contentHash } from '@public-workforce/core';

export interface HttpFetcherOptions {
  userAgent: string;
  beforeRequest?: (url: string) => Promise<void>;
  /** Hard ceiling on a single response body. Protects a worker from a huge file. */
  maxBodyBytes?: number;
  defaultTimeoutMs?: number;
}

/**
 * HTTP transport for the crawl engine.
 *
 * Built on Node's own fetch rather than a crawling framework, because the
 * engine already owns scheduling, rate limiting, robots, retries, budgets,
 * loop protection and checkpointing. What a framework would add on top of that
 * is mostly session pooling and proxy rotation, which are anti-detection
 * features this platform deliberately does not use: a source that blocks us is
 * recorded and left alone. See docs/ARCHITECTURE.md.
 */
export class HttpFetcher implements Fetcher {
  readonly key = 'http';

  constructor(private readonly options: HttpFetcherOptions) {}

  async fetch(request: FetchRequest): Promise<FetchOutcome> {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs ?? 20_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let checkingPolicy = false;
    try {
      let currentUrl = request.url;
      let response: Response;
      let redirects = 0;
      for (;;) {
        checkingPolicy = true;
        await this.options.beforeRequest?.(currentUrl);
        checkingPolicy = false;
        response = await fetch(currentUrl, {
          method: request.method ?? 'GET',
          headers: {
            'user-agent': this.options.userAgent,
            accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            ...request.headers,
          },
          ...(request.body === undefined ? {} : { body: request.body }),
          redirect: 'manual',
          signal: controller.signal,
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (location === null || ++redirects > 5)
            throw new Error('invalid or excessive source redirects');
          currentUrl = new URL(location, currentUrl).href;
          if (!['http:', 'https:'].includes(new URL(currentUrl).protocol))
            throw new Error('unsupported redirect protocol');
          await response.body?.cancel();
          continue;
        }
        break;
      }
      // 401, 403 and 429 are the source telling us to stop. They are not
      // retried and never worked around.
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          failure: {
            url: request.url,
            errorType: response.status === 401 ? 'requires_authentication' : 'blocked_by_source',
            message: `source refused the request with HTTP ${response.status}`,
            status: response.status,
            retryable: false,
          },
        };
      }
      if (response.status === 429) {
        return {
          ok: false,
          failure: {
            url: request.url,
            errorType: 'blocked_by_source',
            message: 'source asked us to slow down (HTTP 429); stopping this target',
            status: 429,
            retryable: false,
          },
        };
      }
      if (response.status >= 500) {
        return {
          ok: false,
          failure: {
            url: request.url,
            errorType: 'http_error',
            message: `server error HTTP ${response.status}`,
            status: response.status,
            retryable: true,
          },
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          failure: {
            url: request.url,
            errorType: 'http_error',
            message: `HTTP ${response.status}`,
            status: response.status,
            retryable: false,
          },
        };
      }

      const body = await this.readBody(response);
      if (body === null) {
        return {
          ok: false,
          failure: {
            url: request.url,
            errorType: 'http_error',
            message: `response exceeded the ${this.options.maxBodyBytes ?? 5_000_000} byte limit`,
            retryable: false,
          },
        };
      }

      return {
        ok: true,
        page: {
          url: request.url,
          finalUrl: response.url.length > 0 ? response.url : currentUrl,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
          contentType: response.headers.get('content-type'),
          fetchedAt: new Date().toISOString(),
          contentHash: contentHash(body),
          fromCache: false,
        },
      };
    } catch (error) {
      if (checkingPolicy) throw error;
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        failure: {
          url: request.url,
          errorType: aborted ? 'timeout' : 'network',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBody(response: Response): Promise<string | null> {
    const limit = this.options.maxBodyBytes ?? 5_000_000;
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > limit) return null;
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > limit ? null : text;
  }
}
