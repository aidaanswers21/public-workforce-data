import type {
  AdapterContext,
  DetectionContext,
  DetectionResult,
  DirectoryAdapter,
  DirectoryVocabulary,
  DiscoveredDirectory,
  ExtractedPersonRecord,
  FetchedPage,
  ListingExtraction,
  PaginationPlan,
} from '@public-workforce/shared-types';
import {
  dedupeExtractedRecords,
  isOrganizationLabel,
  escapeRegExp,
  resolveUrl,
  scoreDirectoryUrl,
} from '@public-workforce/core';
import { loadHtml, textOf, type Html } from '@public-workforce/extraction';
import { clamp01 } from '@public-workforce/adapter-kit';
import {
  extractFromCards,
  extractFromDefinitionLists,
  extractFromMailtoLinks,
  extractFromTables,
  extractStructured,
  extractProfileLinks,
  extractSingleProfile,
} from './extract.js';
import { discoverPaginationFrom } from './pagination.js';

export const GENERIC_HTML_ADAPTER_KEY = 'generic-html';

/**
 * Fallback adapter for directories with no recognizable platform.
 *
 * Sector-agnostic by construction: every word it looks for arrives in the
 * composed vocabulary, so the same adapter reads a federal bureau's leadership
 * page, a county department roster and a school district's staff list without
 * knowing which is which. It scores low on purpose, so any platform-specific
 * adapter that recognizes a page outranks it.
 *
 * Strategies run in descending order of reliability and the first one that
 * yields records wins, so a page with proper JSON-LD is never re-parsed with
 * name-guessing heuristics.
 */
export class GenericHtmlAdapter implements DirectoryAdapter {
  readonly key = GENERIC_HTML_ADAPTER_KEY;
  readonly version = '2.1.0';
  readonly displayName = 'Generic HTML directory';
  readonly detectionThreshold = 0.25;
  readonly requiresBrowser = false;

  detect(context: DetectionContext): DetectionResult {
    const reasons: string[] = [];
    let score = 0;

    const urlScore = scoreDirectoryUrl(context.url, context.vocabulary.urlHints);
    if (urlScore.score > 0) {
      score = Math.max(score, urlScore.score * 0.6);
      reasons.push(...urlScore.reasons);
    }

    if (context.page !== null) {
      const $ = loadHtml(context.page.body);

      if (headingPattern(context.vocabulary).test($('h1, h2, title').text())) {
        score = Math.max(score, 0.6);
        reasons.push('page heading names a people directory');
      }

      const mailtoCount = $('a[href^="mailto:" i]').length;
      if (mailtoCount >= 5) {
        score = Math.max(score, 0.7);
        reasons.push(`${mailtoCount} mailto links`);
      } else if (mailtoCount >= 2) {
        score = Math.max(score, 0.45);
        reasons.push(`${mailtoCount} mailto links`);
      }

      if ($('[itemtype*="schema.org/Person" i]').length > 0) {
        score = Math.max(score, 0.75);
        reasons.push('schema.org Person microdata');
      }
      if (/"@type"\s*:\s*"Person"/i.test(context.page.body)) {
        score = Math.max(score, 0.75);
        reasons.push('JSON-LD Person entries');
      }

      if (this.hasDirectoryTable($)) {
        score = Math.max(score, 0.8);
        reasons.push('table with person and contact columns');
      }
    }

    if (score === 0) reasons.push('no directory signals found');
    return { adapterKey: this.key, score: clamp01(score), platformKey: null, reasons };
  }

  private hasDirectoryTable($: Html): boolean {
    let found = false;
    $('table').each((_index, table) => {
      if (found) return;
      const headers = $(table)
        .find('th')
        .toArray()
        .map((cell) => textOf($, cell).toLowerCase());
      const hasName = headers.some((header) => /name|staff|employee|official/.test(header));
      const hasDetail = headers.some((header) =>
        /e-?mail|title|position|phone|department|office/.test(header),
      );
      if (hasName && hasDetail) found = true;
    });
    return found;
  }

  discoverDirectories(page: FetchedPage, context: AdapterContext): readonly DiscoveredDirectory[] {
    const $ = loadHtml(page.body);
    const found = new Map<string, DiscoveredDirectory>();
    const headings = headingPattern(context.vocabulary);

    $('a[href]').each((_index, element) => {
      const href = $(element).attr('href');
      if (href === undefined) return;
      const resolved = resolveUrl(href, context.baseUrl);
      if (resolved === null) return;

      const label = textOf($, element);
      const urlScore = scoreDirectoryUrl(resolved, context.vocabulary.urlHints);
      const labelScore = headings.test(label) ? 0.7 : 0;
      const score = Math.max(urlScore.score, labelScore);
      if (score < 0.3) return;

      const existing = found.get(resolved);
      if (existing !== undefined && existing.score >= score) return;
      found.set(resolved, {
        url: resolved,
        targetType: 'organization_directory',
        sourceTypeCode: 'html_directory',
        score,
        reasons: [...urlScore.reasons, ...(labelScore > 0 ? [`link text "${label}"`] : [])],
      });
    });

    return [...found.values()].sort((a, b) => b.score - a.score);
  }

  extractListing(page: FetchedPage, context: AdapterContext): ListingExtraction {
    const $ = loadHtml(page.body);
    const input = {
      $,
      sourceUrl: page.finalUrl,
      adapterKey: this.key,
      vocabulary: context.vocabulary,
    };
    const warnings: string[] = [];

    const strategies: readonly [string, () => ExtractedPersonRecord[]][] = [
      ['structured', () => extractStructured(input)],
      ['table', () => extractFromTables(input)],
      ['card', () => extractFromCards(input)],
      ['definition-list', () => extractFromDefinitionLists(input)],
      ['mailto', () => extractFromMailtoLinks(input)],
    ];

    let records: ExtractedPersonRecord[] = [];
    let usedStrategy = 'none';
    for (const [name, run] of strategies) {
      if (name === 'mailto' && records.length > 0) continue;
      const produced = run();
      if (produced.length > 0) {
        records = dedupeExtractedRecords([...records, ...produced]);
        usedStrategy = name;
      }
    }

    if (usedStrategy === 'mailto' && records.length > 0) {
      warnings.push(
        'fell back to mailto harvesting; records are low confidence and should be reviewed',
      );
    }

    if (records.length === 0) records = extractProfileLinks(input);

    const pagination = discoverPaginationFrom(
      $,
      page.finalUrl,
      context.vocabulary.organizationFieldAliases,
    );
    if (records.length === 0 && pagination.note?.includes('search-only') === true) {
      warnings.push('directory appears to be search-only and cannot be enumerated by this adapter');
    }

    return {
      records,
      pagination,
      context: this.pageContext($, context),
      empty: records.length === 0,
      warnings,
    };
  }

  private pageContext($: Html, context: AdapterContext): Record<string, string> {
    const out: Record<string, string> = {};
    const heading = textOf($, $('h1').first());
    if (heading.length > 0) out['heading'] = heading;
    if (context.organizationName !== null) out['organization'] = context.organizationName;
    if (context.parentOrganizationName !== null)
      out['parentOrganization'] = context.parentOrganizationName;
    return out;
  }

  extractProfile(page: FetchedPage, context: AdapterContext): ExtractedPersonRecord | null {
    const $ = loadHtml(page.body);
    $('nav, footer, aside').remove();
    const input = {
      $,
      sourceUrl: page.finalUrl,
      adapterKey: this.key,
      vocabulary: context.vocabulary,
    };

    const structured = extractStructured(input);
    if (structured.length > 0) return structured.length === 1 ? (structured[0] ?? null) : null;

    const cards = extractFromCards(input);
    if (cards.length > 0) return cards.length === 1 ? (cards[0] ?? null) : null;

    const profile = extractSingleProfile(input);
    if (profile !== null) return profile;

    const mailto = extractFromMailtoLinks(input);
    const single = mailto.length === 1 ? mailto[0] : undefined;
    return single !== undefined &&
      !isOrganizationLabel(single.fullNamePublished, context.vocabulary.organizationLabelWords)
      ? single
      : null;
  }

  discoverPagination(page: FetchedPage, context: AdapterContext): PaginationPlan {
    return discoverPaginationFrom(
      loadHtml(page.body),
      page.finalUrl,
      context.vocabulary.organizationFieldAliases,
    );
  }
}

/**
 * Build a heading matcher from the composed vocabulary.
 *
 * Cached per vocabulary object so a long term list is not recompiled for every
 * link on a page.
 */
const headingPatternCache = new WeakMap<DirectoryVocabulary, RegExp>();

function headingPattern(vocabulary: DirectoryVocabulary): RegExp {
  const cached = headingPatternCache.get(vocabulary);
  if (cached !== undefined) return cached;
  const terms = vocabulary.headingTerms.filter((term) => term.trim().length > 0).map(escapeRegExp);
  const pattern = terms.length === 0 ? /(?!)/ : new RegExp(`\\b(${terms.join('|')})\\b`, 'i');
  headingPatternCache.set(vocabulary, pattern);
  return pattern;
}

export const genericHtmlAdapter = new GenericHtmlAdapter();
