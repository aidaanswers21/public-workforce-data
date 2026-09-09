import { chromium, type Browser } from 'playwright';
import { contentHash } from '@public-workforce/core';
import type {
  Fetcher,
  FetchRequest,
  FetchOutcome,
  FetchFailure,
} from '@public-workforce/shared-types';

/** Render public content through the same guarded, archived transport as ordinary requests. */
export class BrowserFetcher implements Fetcher {
  readonly key = 'browser';
  private browser: Promise<Browser> | null = null;
  constructor(
    private readonly transport: Fetcher,
    private readonly userAgent: string,
  ) {}

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
    let failure: FetchFailure | null = null;
    const transportState: { error?: Error } = {};
    const pending = new Set<Promise<void>>();
    try {
      await context.routeWebSocket('**', (route) => route.close());
      await context.route('**/*', async (route) => {
        const operation = (async () => {
          const incoming = route.request();
          if (['image', 'font', 'media', 'websocket'].includes(incoming.resourceType())) {
            await route.abort();
            return;
          }
          const method = incoming.method();
          if (method !== 'GET' && method !== 'POST') {
            await route.abort();
            return;
          }
          const response =
            incoming.url() === initial.page.finalUrl && incoming.isNavigationRequest()
              ? initial
              : await this.transport.fetch({
                  url: incoming.url(),
                  method,
                  ...(incoming.postData() === null ? {} : { body: incoming.postData() as string }),
                  headers: { 'content-type': incoming.headers()['content-type'] ?? 'text/plain' },
                  timeoutMs: request.timeoutMs ?? 20000,
                });
          if (!response.ok) {
            failure = response.failure;
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
        } catch (error) {
          transportState.error = error instanceof Error ? error : new Error(String(error));
          await route.abort().catch(() => undefined);
        } finally {
          pending.delete(operation);
        }
      });
      const page = await context.newPage();
      await page.goto(initial.page.finalUrl, {
        waitUntil: 'domcontentloaded',
        timeout: request.timeoutMs ?? 20000,
      });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      await Promise.all([...pending]);
      if (transportState.error !== undefined) throw transportState.error;
      if (failure !== null) return { ok: false, failure };
      const body = await page.content();
      return {
        ok: true,
        page: { ...initial.page, body, contentHash: contentHash(body), storageKey: null },
      };
    } finally {
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
