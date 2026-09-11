import { describe, expect, it } from 'vitest';
import { parseBrowserRenderDomains, shouldRenderWithBrowser } from './browser-rendering.js';

describe('browser rendering selection', () => {
  it('is off when no host is configured', () => {
    expect(parseBrowserRenderDomains(undefined)).toEqual([]);
    expect(shouldRenderWithBrowser('https://school.example.org/staff', [])).toBe(false);
  });

  it('selects only exact configured hosts', () => {
    const domains = parseBrowserRenderDomains(' Example.org, directory.vendor.test ');
    expect(domains).toEqual(['example.org', 'directory.vendor.test']);
    expect(shouldRenderWithBrowser('https://example.org/staff', domains)).toBe(true);
    expect(shouldRenderWithBrowser('https://school.example.org/staff', domains)).toBe(false);
    expect(shouldRenderWithBrowser('https://notexample.org/staff', domains)).toBe(false);
    expect(shouldRenderWithBrowser('https://vendor.test/staff', domains)).toBe(false);
  });

  it.each(['https://example.org', '*.example.org', 'example.org/path', 'example.org:443'])(
    'rejects a non-host entry: %s',
    (entry) => {
      expect(() => parseBrowserRenderDomains(entry)).toThrow(
        'CRAWLER_RENDER_BROWSER_DOMAINS must contain comma-separated hostnames',
      );
    },
  );
});
