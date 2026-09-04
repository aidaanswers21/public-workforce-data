/** Query parameters that never change the content served. */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  '_ga',
  'ref',
  'referrer',
]);

/**
 * Canonical form used for de-duplication and `urlHash`.
 *
 * Scheme and host are lower-cased, default ports and fragments dropped,
 * tracking parameters removed, remaining parameters sorted, and a trailing
 * slash normalized away. Two URLs that serve the same page should collapse to
 * one string here, because the crawl frontier trusts this for loop protection.
 */
export function canonicalizeUrl(input: string, base?: string): string | null {
  let url: URL;
  try {
    url = base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  return url.toString();
}

export function domainOf(input: string): string | null {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * United States locality-domain function labels.
 *
 * These appear in two shapes, and getting them wrong collapses every public
 * body in a state onto one apparent site:
 *
 *   sample.k12.tx.us   label directly before the state; the site includes the
 *                      label to its left
 *   ci.austin.tx.us    label before a place name; the site starts at the label
 */
const STATE_LABEL = /^[a-z]{2}$/;

/**
 * The registrable root of a hostname: the part two hosts must share to be the
 * same site.
 */
export function registrableDomain(
  hostname: string,
  localityLabels: readonly string[] = [],
): string {
  const parts = hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.');
  if (parts.length <= 2) return parts.join('.');

  const labels = new Set(localityLabels);
  if (parts.at(-1) === 'us' && labels.size > 0) {
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      const label = parts[index] as string;
      if (!labels.has(label)) continue;
      // <label>.<state>.us, so the site is one label further left.
      if (STATE_LABEL.test(parts[index + 1] ?? '') && parts.length - index === 3) {
        return parts.slice(Math.max(0, index - 1)).join('.');
      }
      // <label>.<place>.<state>.us, so the site starts at the label.
      if (STATE_LABEL.test(parts[index + 2] ?? '') && parts.length - index === 4) {
        return parts.slice(index).join('.');
      }
    }
  }

  if (/^(co|ac|gov|edu|org|net|com)\.[a-z]{2}$/.test(parts.slice(-2).join('.'))) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

export function isSameRegistrableDomain(
  a: string,
  b: string,
  localityLabels: readonly string[] = [],
): boolean {
  return registrableDomain(a, localityLabels) === registrableDomain(b, localityLabels);
}

/**
 * URL path fragments that reliably indicate non-directory content.
 *
 * Crawling these wastes budget and pollutes the record set. Calendars and news
 * archives in particular generate effectively unbounded paginated URL spaces,
 * which is the classic way a directory crawl turns into an unbounded crawl.
 */
export const DEFAULT_URL_EXCLUSION_PATTERNS: readonly RegExp[] = [
  /\/(calendar|events?|event-calendar|ical)(\/|$|\?)/i,
  /\/(news|press|blog|announcements?|archives?|stories)(\/|$|\?)/i,
  /\/(athletics\/schedule|schedules?|scores|standings)(\/|$|\?)/i,
  /\/(tag|tags|category|categories|author)(\/|$)/i,
  /\/(login|signin|sign-in|account|register|portal|sso|auth)(\/|$|\?)/i,
  /\/(search)(\/|$)\?.*\b(date|month|year)=/i,
  /\/(menus?|lunch-menu|nutrition-menu)(\/|$)/i,
  /\/(gallery|photos?|media\/photos)(\/|$)/i,
  /\/(cart|checkout|donate|store|shop)(\/|$)/i,
  /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|jpg|jpeg|png|gif|svg|mp4|mp3|ics|rss|xml)(\?|$)/i,
  /[?&](month|year|cal_date|date)=\d/i,
  /\/(wp-admin|wp-login|xmlrpc\.php)(\/|$)/i,
];

export function isExcludedUrl(
  url: string,
  patterns: readonly RegExp[] = DEFAULT_URL_EXCLUSION_PATTERNS,
): { excluded: boolean; pattern: string | null } {
  for (const pattern of patterns) {
    if (pattern.test(url)) return { excluded: true, pattern: pattern.source };
  }
  return { excluded: false, pattern: null };
}

/**
 * Score a URL as a likely people directory.
 *
 * The hints come from the composed vocabulary rather than a fixed list, so a
 * federal "field offices" page and an education "faculty" page are both
 * recognizable without the core knowing which is which.
 */
export function scoreDirectoryUrl(
  url: string,
  urlHints: readonly { pattern: string; weight: number }[],
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  for (const hint of urlHints) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(hint.pattern, 'i');
    } catch {
      continue;
    }
    if (pattern.test(url)) {
      score = Math.max(score, hint.weight);
      reasons.push(`url matches ${hint.pattern}`);
    }
  }
  const excluded = isExcludedUrl(url);
  if (excluded.excluded) {
    score = 0;
    reasons.push(`excluded by ${excluded.pattern ?? 'policy'}`);
  }
  return { score, reasons };
}

/** Resolve a possibly relative href against a base, returning canonical form. */
export function resolveUrl(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  if (/^(mailto:|tel:|javascript:|#)/i.test(trimmed)) return null;
  return canonicalizeUrl(trimmed, baseUrl);
}
