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

/** Registrable-ish root: drops one leading label per call until two remain. */
export function registrableDomain(hostname: string): string {
  const parts = hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.');
  if (parts.length <= 2) return parts.join('.');
  // Handles the common ".k12.tx.us" style suffix used by US school districts.
  const tail = parts.slice(-3).join('.');
  if (/^k12\.[a-z]{2}\.us$/.test(tail)) return parts.slice(-4).join('.');
  if (/^(co|ac|gov|edu|org|net|com)\.[a-z]{2}$/.test(parts.slice(-2).join('.'))) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

export function isSameRegistrableDomain(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
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

/** Hints that a URL is a staff directory. Used to rank discovery candidates. */
export const DIRECTORY_URL_HINTS: readonly { pattern: RegExp; weight: number }[] = [
  { pattern: /\/(staff|faculty)-directory(\/|$)/i, weight: 1.0 },
  { pattern: /\/(staff|faculty|employees?|personnel)(\/|$)/i, weight: 0.8 },
  { pattern: /\/directory(\/|$)/i, weight: 0.75 },
  { pattern: /\/(our-)?(team|people)(\/|$)/i, weight: 0.6 },
  { pattern: /\/(administration|admin-team|leadership)(\/|$)/i, weight: 0.55 },
  { pattern: /\/contact-us?(\/|$)/i, weight: 0.35 },
  { pattern: /\/departments?(\/|$)/i, weight: 0.3 },
];

export function scoreDirectoryUrl(url: string): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  for (const hint of DIRECTORY_URL_HINTS) {
    if (hint.pattern.test(url)) {
      score = Math.max(score, hint.weight);
      reasons.push(`url matches ${hint.pattern.source}`);
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
