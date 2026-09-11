import { describe, expect, it } from 'vitest';
import { BrowserFetcher } from './browser-fetcher.js';
import { contentHash } from '@public-workforce/core';
import type { Fetcher } from '@public-workforce/shared-types';

describe('browser rendering through fixture transport', () => {
  it('uses a separate guarded transport for JavaScript resources', async () => {
    const pageUrls: string[] = [];
    const resourceUrls: string[] = [];
    const pageTransport: Fetcher = {
      key: 'fixture-page',
      fetch: (request) => {
        pageUrls.push(request.url);
        const body = `<html><body><div id="contacts"></div><script>fetch('/contacts.json').then(r=>r.json()).then(rows=>document.getElementById('contacts').textContent=rows[0].name)</script></body></html>`;
        return Promise.resolve({
          ok: true,
          page: {
            url: request.url,
            finalUrl: request.url,
            status: 200,
            headers: {},
            body,
            contentType: 'text/html',
            fetchedAt: new Date().toISOString(),
            contentHash: contentHash(body),
            fromCache: true,
            storageKey: 'fixture:raw',
          },
        });
      },
    };
    const resourceTransport: Fetcher = {
      key: 'fixture-resource',
      fetch: (request) => {
        resourceUrls.push(request.url);
        const body = '[{"name":"Alex Rivera"}]';
        return Promise.resolve({
          ok: true,
          page: {
            url: request.url,
            finalUrl: request.url,
            status: 200,
            headers: {},
            body,
            contentType: 'application/json',
            fetchedAt: new Date().toISOString(),
            contentHash: contentHash(body),
            fromCache: true,
            storageKey: 'fixture:resource',
          },
        });
      },
    };
    const browser = new BrowserFetcher(pageTransport, 'FixtureBot/1', resourceTransport);
    try {
      const result = await browser.fetch({ url: 'https://fixture.invalid/' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.page.body).toContain('<div id="contacts">Alex Rivera</div>');
        expect(result.page.storageKey).toBeNull();
      }
      expect(pageUrls).toEqual(['https://fixture.invalid/']);
      expect(resourceUrls).toEqual(['https://fixture.invalid/contacts.json']);
    } finally {
      await browser.close();
    }
  });

  it('aborts a disallowed third-party subresource without failing the page', async () => {
    const resourceUrls: string[] = [];
    const pageTransport: Fetcher = {
      key: 'fixture-page',
      fetch: (request) => {
        const body = `<html><body><main>Published directory</main><script src="https://third-party.invalid/widget.js"></script></body></html>`;
        return Promise.resolve({
          ok: true,
          page: {
            url: request.url,
            finalUrl: request.url,
            status: 200,
            headers: {},
            body,
            contentType: 'text/html',
            fetchedAt: new Date().toISOString(),
            contentHash: contentHash(body),
            fromCache: true,
            storageKey: 'fixture:raw',
          },
        });
      },
    };
    const resourceTransport: Fetcher = {
      key: 'fixture-resource',
      fetch: (request) => {
        resourceUrls.push(request.url);
        return Promise.reject(new Error('source policy refuses this resource'));
      },
    };
    const browser = new BrowserFetcher(pageTransport, 'FixtureBot/1', resourceTransport);
    try {
      const result = await browser.fetch({ url: 'https://fixture.invalid/' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.page.body).toContain('Published directory');
      expect(resourceUrls).toEqual(['https://third-party.invalid/widget.js']);
    } finally {
      await browser.close();
    }
  });

  it('caps subresource attempts for each rendered page', async () => {
    const resourceUrls: string[] = [];
    const pageTransport = fixturePageTransport(
      `<html><body><main>Bounded directory</main><script>
        Promise.all(Array.from({ length: 5 }, (_, index) => fetch('/resource-' + index + '.json')))
      </script></body></html>`,
    );
    const resourceTransport: Fetcher = {
      key: 'fixture-resource',
      fetch: (request) => {
        resourceUrls.push(request.url);
        const body = '{}';
        return Promise.resolve({
          ok: true,
          page: {
            url: request.url,
            finalUrl: request.url,
            status: 200,
            headers: {},
            body,
            contentType: 'application/json',
            fetchedAt: new Date().toISOString(),
            contentHash: contentHash(body),
            fromCache: true,
            storageKey: 'fixture:resource',
          },
        });
      },
    };
    const browser = new BrowserFetcher(pageTransport, 'FixtureBot/1', resourceTransport, {
      maxSubresourceRequests: 2,
      renderDeadlineMs: 5_000,
    });
    try {
      const result = await browser.fetch({ url: 'https://fixture.invalid/' });
      expect(result.ok).toBe(true);
      expect(resourceUrls).toHaveLength(2);
    } finally {
      await browser.close();
    }
  });

  it('stops a pending subresource at the wall-clock deadline', async () => {
    const body = `<html><body><main>Static fallback</main><script>fetch('/never.json')</script></body></html>`;
    const resourceTransport: Fetcher = {
      key: 'fixture-resource',
      fetch: () => new Promise(() => undefined),
    };
    const browser = new BrowserFetcher(
      fixturePageTransport(body),
      'FixtureBot/1',
      resourceTransport,
      {
        maxSubresourceRequests: 5,
        renderDeadlineMs: 100,
      },
    );
    try {
      const result = await browser.fetch({ url: 'https://fixture.invalid/' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.page.body).toBe(body);
    } finally {
      await browser.close();
    }
  });

  it('rejects non-positive browser safety limits before launch', () => {
    const transport = fixturePageTransport('<html></html>');
    expect(
      () =>
        new BrowserFetcher(transport, 'FixtureBot/1', transport, {
          maxSubresourceRequests: 0,
          renderDeadlineMs: 100,
        }),
    ).toThrow('maxSubresourceRequests must be a positive integer');
    expect(
      () =>
        new BrowserFetcher(transport, 'FixtureBot/1', transport, {
          maxSubresourceRequests: 1,
          renderDeadlineMs: 0,
        }),
    ).toThrow('renderDeadlineMs must be a positive integer');
  });
});

function fixturePageTransport(body: string): Fetcher {
  return {
    key: 'fixture-page',
    fetch: (request) =>
      Promise.resolve({
        ok: true,
        page: {
          url: request.url,
          finalUrl: request.url,
          status: 200,
          headers: {},
          body,
          contentType: 'text/html',
          fetchedAt: new Date().toISOString(),
          contentHash: contentHash(body),
          fromCache: true,
          storageKey: 'fixture:raw',
        },
      }),
  };
}
