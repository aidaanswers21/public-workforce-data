import { describe, expect, it } from 'vitest';
import { BrowserFetcher } from './browser-fetcher.js';
import { contentHash } from '@public-workforce/core';
import type { Fetcher } from '@public-workforce/shared-types';

describe('browser rendering through fixture transport', () => {
  it.each([false, true])(
    'guards JavaScript resource requests (policy refusal: %s)',
    async (refuse) => {
      const urls: string[] = [];
      const transport: Fetcher = {
        key: 'fixture',
        fetch: (request) => {
          urls.push(request.url);
          if (refuse && request.url.endsWith('/contacts.json')) {
            return Promise.reject(new Error('source policy refuses this resource'));
          }
          const body = request.url.endsWith('/contacts.json')
            ? '[{"name":"Alex Rivera"}]'
            : `<html><body><div id="contacts"></div><script>fetch('/contacts.json').then(r=>r.json()).then(rows=>document.getElementById('contacts').textContent=rows[0].name)</script></body></html>`;
          return Promise.resolve({
            ok: true,
            page: {
              url: request.url,
              finalUrl: request.url,
              status: 200,
              headers: {},
              body,
              contentType: request.url.endsWith('.json') ? 'application/json' : 'text/html',
              fetchedAt: new Date().toISOString(),
              contentHash: contentHash(body),
              fromCache: true,
              storageKey: 'fixture:raw',
            },
          });
        },
      };
      const browser = new BrowserFetcher(transport, 'FixtureBot/1');
      try {
        if (refuse) {
          await expect(browser.fetch({ url: 'https://fixture.invalid/' })).rejects.toThrow(
            'source policy refuses this resource',
          );
          return;
        }
        const result = await browser.fetch({ url: 'https://fixture.invalid/' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.page.body).toContain('<div id="contacts">Alex Rivera</div>');
          expect(result.page.storageKey).toBeNull();
        }
        expect(urls).toEqual(['https://fixture.invalid/', 'https://fixture.invalid/contacts.json']);
      } finally {
        await browser.close();
      }
    },
  );
});
