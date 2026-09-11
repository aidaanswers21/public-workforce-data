import { chromium, type Browser } from 'playwright';
import { contentHash } from '@public-workforce/core';
import type { Fetcher, FetchRequest, FetchOutcome } from '@public-workforce/shared-types';
import type { Route } from 'playwright';

export interface BrowserFetcherLimits {
  maxSubresourceRequests: number;
  renderDeadlineMs: number;
}

const DEFAULT_LIMITS: BrowserFetcherLimits = {
  maxSubresourceRequests: 50,
  renderDeadlineMs: 20_000,
};

/** Render public content through the same guarded, archived transport as ordinary requests. */
export class BrowserFetcher implements Fetcher {
  readonly key = 'browser';
  private browser: Promise<Browser> | null = null;
  constructor(
    private readonly transport: Fetcher,
    private readonly userAgent: string,
    private readonly resourceTransport: Fetcher = transport,
    private readonly limits: BrowserFetcherLimits = DEFAULT_LIMITS,
  ) {
    assertPositiveInteger(limits.maxSubresourceRequests, 'maxSubresourceRequests');
    assertPositiveInteger(limits.renderDeadlineMs, 'renderDeadlineMs');
  }

  async fetch(request: FetchRequest): Promise<FetchOutcome> {
    const initial = await this.transport.fetch(request);
    if (!initial.ok || !initial.page.contentType?.includes('html')) return initial;
    if (
      /g-recaptcha|hcaptcha|cf-challenge|challenge-platform|verify you are human/i.test(
        initial.page.body,
      )
    )
      return initial;
    this.browser ??= chromium.launch({ headless: true });
    const browser = await this.browser;
    const context = await browser.newContext({
      userAgent: this.userAgent,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    const deadlineAt = Date.now() + this.limits.renderDeadlineMs;
    let deadlineExpired = false;
    let acceptingSubresources = true;
    let subresourceRequests = 0;
    const pending = new Set<Promise<void>>();
    const activeRoutes = new Set<Route>();
    let expireDeadline: (() => void) | undefined;
    const deadlineReached = new Promise<void>((resolve) => {
      expireDeadline = resolve;
    });
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      for (const route of activeRoutes) void route.abort().catch(() => undefined);
      expireDeadline?.();
    }, this.limits.renderDeadlineMs);
    try {
      await context.routeWebSocket('**', (route) => route.close());
      await context.route('**/*', async (route) => {
        activeRoutes.add(route);
        const operation = (async () => {
          const incoming = route.request();
          const isInitialNavigation =
            incoming.url() === initial.page.finalUrl && incoming.isNavigationRequest();
          if (deadlineExpired || Date.now() >= deadlineAt) {
            await route.abort();
            return;
          }
          if (['image', 'font', 'media', 'websocket'].includes(incoming.resourceType())) {
            await route.abort();
            return;
          }
          const method = incoming.method();
          if (method !== 'GET' && method !== 'POST') {
            await route.abort();
            return;
          }
          if (
            !isInitialNavigation &&
            (!acceptingSubresources || subresourceRequests >= this.limits.maxSubresourceRequests)
          ) {
            await route.abort();
            return;
          }
          if (!isInitialNavigation) subresourceRequests += 1;
          const response = isInitialNavigation
            ? initial
            : await beforeDeadline(
                this.resourceTransport.fetch({
                  url: incoming.url(),
                  method,
                  ...(incoming.postData() === null ? {} : { body: incoming.postData() as string }),
                  headers: { 'content-type': incoming.headers()['content-type'] ?? 'text/plain' },
                  timeoutMs: Math.min(
                    request.timeoutMs ?? 20_000,
                    Math.max(1, deadlineAt - Date.now()),
                  ),
                }),
                deadlineAt,
              );
          if (!response.ok) {
            await route.abort();
            return;
          }
          await route.fulfill({
            status: response.page.status,
            contentType: response.page.contentType ?? 'text/plain',
            body: response.page.body,
          });
        })();
        pending.add(operation);
        try {
          await operation;
        } catch {
          // A refused optional script or API is not permission to fail or widen
          // the approved top-level page. Aborting leaves missing content visible
          // to coverage review instead of converting it into a transport error.
          await route.abort().catch(() => undefined);
        } finally {
          pending.delete(operation);
          activeRoutes.delete(route);
        }
      });
      const page = await context.newPage();
      await beforeDeadline(
        page.goto(initial.page.finalUrl, {
          waitUntil: 'domcontentloaded',
          timeout: Math.max(1, deadlineAt - Date.now()),
        }),
        deadlineAt,
      ).catch((error: unknown) => {
        if (!(error instanceof BrowserRenderDeadlineError) && Date.now() < deadlineAt) throw error;
      });
      if (!deadlineExpired) {
        await beforeDeadline(
          page.waitForLoadState('networkidle', {
            timeout: Math.min(5000, Math.max(1, deadlineAt - Date.now())),
          }),
          deadlineAt,
        ).catch(() => undefined);
      }
      await Promise.race([Promise.allSettled([...pending]), deadlineReached]);
      acceptingSubresources = false;
      for (const route of activeRoutes) await route.abort().catch(() => undefined);
      const body = deadlineExpired
        ? initial.page.body
        : await beforeDeadline(page.content(), deadlineAt).catch(() => initial.page.body);
      return {
        ok: true,
        page: { ...initial.page, body, contentHash: contentHash(body), storageKey: null },
      };
    } finally {
      clearTimeout(deadlineTimer);
      for (const route of activeRoutes) await route.abort().catch(() => undefined);
      await context.close();
    }
  }
  async close(): Promise<void> {
    if (this.browser !== null) {
      await (await this.browser).close();
      this.browser = null;
    }
  }
}

class BrowserRenderDeadlineError extends Error {
  constructor() {
    super('browser render deadline reached');
  }
}

async function beforeDeadline<T>(operation: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new BrowserRenderDeadlineError();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BrowserRenderDeadlineError()), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}
