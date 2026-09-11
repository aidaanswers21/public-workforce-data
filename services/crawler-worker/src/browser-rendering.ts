/** Parse the explicit hosts allowed to use browser rendering. */
export function parseBrowserRenderDomains(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  return [...new Set(raw.split(',').map(parseHost))];
}

/** Rendering is an exact-host opt-in, not an expansion of source approval. */
export function shouldRenderWithBrowser(
  url: string,
  configuredDomains: readonly string[],
): boolean {
  if (configuredDomains.length === 0) return false;
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  return configuredDomains.includes(host);
}

function parseHost(entry: string): string {
  const candidate = entry.trim().toLowerCase().replace(/\.$/, '');
  if (candidate.length === 0 || /[\s/:*?#]/.test(candidate)) {
    throw new Error(
      'CRAWLER_RENDER_BROWSER_DOMAINS must contain comma-separated hostnames without schemes, ports, paths, or wildcards',
    );
  }
  const parsed = new URL(`https://${candidate}`);
  if (parsed.hostname !== candidate) {
    throw new Error(`invalid browser-rendering hostname: ${entry.trim()}`);
  }
  return candidate;
}
