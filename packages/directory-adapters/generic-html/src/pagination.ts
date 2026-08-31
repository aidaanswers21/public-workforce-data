import type {
  PaginationKind,
  PaginationPlan,
  PaginationRequest,
} from '@public-workforce/shared-types';
import { canonicalizeUrl, resolveUrl } from '@public-workforce/core';
import type { Html } from '@public-workforce/extraction';
import { textOf } from '@public-workforce/extraction';

const NEXT_TEXT = /^(next|next page|next\s*[>»›]|[>»›]|older|more results)$/i;
const PREV_TEXT = /^(prev|previous|back|[<«‹])$/i;
const PAGE_PARAMS = ['page', 'p', 'pg', 'pagenum', 'page_number', 'start', 'offset', 'from'];

/**
 * Tokens are the canonical target URL.
 *
 * Using the destination rather than a page number means a directory whose
 * "next" link eventually points back at a page we have already followed is
 * caught by the engine's loop guard even when the link text keeps saying "next".
 */
function tokenFor(kind: PaginationKind, url: string): string {
  return `${kind}:${url}`;
}

function push(
  into: Map<string, PaginationRequest>,
  kind: PaginationKind,
  rawUrl: string,
  baseUrl: string,
  context?: Record<string, unknown>,
): void {
  const resolved = resolveUrl(rawUrl, baseUrl);
  if (resolved === null) return;
  const token = tokenFor(kind, resolved);
  if (into.has(token)) return;
  into.set(token, { url: resolved, kind, token, ...(context === undefined ? {} : { context }) });
}

/**
 * Find every way this page offers to reach more records.
 *
 * Ordered by reliability: an explicit rel=next beats a guessed page parameter,
 * and filters (alphabet, department, organization) are only used when no sequential
 * pagination exists, because enumerating filters on top of pagination multiplies
 * the crawl for no extra coverage.
 */
export function discoverPaginationFrom(
  $: Html,
  baseUrl: string,
  organizationTerms: readonly string[] = [],
): PaginationPlan {
  const requests = new Map<string, PaginationRequest>();
  let kind: PaginationKind | null = null;
  const notes: string[] = [];

  const relNext = $('link[rel="next"], a[rel="next"]').first();
  const relNextHref = relNext.attr('href');
  if (relNextHref !== undefined) {
    push(requests, 'next_link', relNextHref, baseUrl);
    kind = 'next_link';
    notes.push('rel=next');
  }

  if (kind === null) {
    $('a[href]').each((_index, element) => {
      const label = textOf($, element);
      const aria = $(element).attr('aria-label') ?? '';
      if (!NEXT_TEXT.test(label) && !NEXT_TEXT.test(aria)) return;
      if (PREV_TEXT.test(label)) return;
      const href = $(element).attr('href');
      if (href === undefined) return;
      push(requests, 'next_link', href, baseUrl);
      kind = 'next_link';
      notes.push('next link text');
    });
  }

  const paginationContainer = $(
    '.pagination, .pager, .page-numbers, nav[aria-label*="pag" i], ul[class*="pagination" i]',
  );
  if (paginationContainer.length > 0) {
    paginationContainer.find('a[href]').each((_index, element) => {
      const label = textOf($, element);
      if (!/^\d+$/.test(label)) return;
      const href = $(element).attr('href');
      if (href === undefined) return;
      push(requests, 'numbered', href, baseUrl, { page: Number(label) });
      if (kind === null) kind = 'numbered';
    });
    if (requests.size > 0) notes.push('numbered pagination container');
  }

  const loadMore = $(
    'button[data-next-url], button[data-load-more], a[data-load-more], [data-next-page], [data-infinite-scroll]',
  );
  loadMore.each((_index, element) => {
    const node = $(element);
    const href =
      node.attr('data-next-url') ??
      node.attr('data-next-page') ??
      node.attr('data-load-more') ??
      node.attr('data-url') ??
      node.attr('href');
    if (href === undefined || href.length === 0) return;
    const isScroll = node.attr('data-infinite-scroll') !== undefined;
    push(requests, isScroll ? 'infinite_scroll' : 'load_more', href, baseUrl);
    if (kind === null) kind = isScroll ? 'infinite_scroll' : 'load_more';
    notes.push(isScroll ? 'infinite scroll endpoint' : 'load-more control');
  });

  if (requests.size === 0) {
    const guessed = guessNextFromQuery(baseUrl);
    if (guessed !== null) {
      push(requests, guessed.kind, guessed.url, baseUrl);
      kind = guessed.kind;
      notes.push(`incremented ${guessed.param} parameter`);
    }
  }

  if (requests.size === 0) {
    const alpha = collectAlphaFilters($, baseUrl);
    for (const href of alpha) push(requests, 'alpha_filter', href, baseUrl);
    if (alpha.length > 0) {
      kind = 'alpha_filter';
      notes.push('alphabetical filter links');
    }
  }

  if (requests.size === 0) {
    const filters = collectSelectFilters($, organizationTerms);
    for (const filter of filters) push(requests, filter.kind, filter.url, baseUrl);
    if (filters.length > 0) {
      kind = filters[0]?.kind ?? null;
      notes.push('filter select options');
    }
  }

  if (requests.size === 0 && hasSearchInterface($)) {
    notes.push(
      'search-only directory: no enumerable listing found, needs a platform adapter or an approved query plan',
    );
  }

  return {
    kind,
    requests: [...requests.values()],
    exhausted: requests.size === 0,
    note: notes.length > 0 ? notes.join('; ') : null,
  };
}

/** Increment whichever page-like query parameter the current URL already uses. */
function guessNextFromQuery(
  baseUrl: string,
): { url: string; param: string; kind: PaginationKind } | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  for (const param of PAGE_PARAMS) {
    const raw = url.searchParams.get(param);
    if (raw === null) continue;
    const current = Number.parseInt(raw, 10);
    if (!Number.isFinite(current)) continue;
    const isOffset = param === 'offset' || param === 'start' || param === 'from';
    const step = isOffset ? Math.max(1, current === 0 ? 25 : current) : 1;
    const next = new URL(url.toString());
    next.searchParams.set(param, String(current + step));
    const canonical = canonicalizeUrl(next.toString());
    if (canonical === null) continue;
    return { url: canonical, param, kind: isOffset ? 'offset_param' : 'page_param' };
  }
  return null;
}

function collectAlphaFilters($: Html, _baseUrl: string): string[] {
  const hrefs: string[] = [];
  $('a[href]').each((_index, element) => {
    const label = textOf($, element);
    if (!/^[A-Z]$/.test(label)) return;
    const href = $(element).attr('href');
    if (href === undefined) return;
    hrefs.push(href);
  });
  // A single stray letter link is not an alphabet index.
  return hrefs.length >= 5 ? hrefs : [];
}

/**
 * Filter controls that split a directory by unit or by organization.
 *
 * The organization terms come from the composed vocabulary, so a select named
 * "campus" and one named "bureau" are both recognized without this package
 * knowing which vertical contributed either word.
 */
function collectSelectFilters(
  $: Html,
  organizationTerms: readonly string[],
): { url: string; kind: PaginationKind }[] {
  const out: { url: string; kind: PaginationKind }[] = [];
  const organizationNames = new Set(
    organizationTerms.map((term) => term.toLowerCase().replace(/[^a-z]+/g, '')),
  );
  $('select[name]').each((_index, element) => {
    const name = ($(element).attr('name') ?? '').toLowerCase();
    const compact = name.replace(/[^a-z]+/g, '');
    const kind: PaginationKind | null = /department|dept|division/.test(name)
      ? 'department_filter'
      : organizationNames.has(compact)
        ? 'organization_filter'
        : null;
    if (kind === null) return;
    $(element)
      .find('option[value]')
      .each((_optionIndex, option) => {
        const value = $(option).attr('value') ?? '';
        if (value.length === 0) return;
        out.push({ url: `?${name}=${encodeURIComponent(value)}`, kind });
      });
  });
  return out;
}

function hasSearchInterface($: Html): boolean {
  return (
    $('form input[type="search"], form input[name*="search" i], form input[name*="query" i]')
      .length > 0
  );
}
