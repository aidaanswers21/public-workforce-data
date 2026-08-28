import type {
  AdapterContext,
  DetectionContext,
  DetectionResult,
  DirectoryAdapter,
  DiscoveredDirectory,
  ExtractedPersonRecord,
  FetchedPage,
  ListingExtraction,
  PaginationPlan,
} from '@pan/shared-types';
import { dedupeExtractedRecords, resolveUrl, scoreDirectoryUrl } from '@pan/core';
import { loadHtml, textOf, type Html } from '@pan/extraction';
import { clamp01 } from '@pan/adapter-kit';
import {
  extractFromCards,
  extractFromDefinitionLists,
  extractFromMailtoLinks,
  extractFromTables,
  extractStructured,
} from './extract.js';
import { discoverPaginationFrom } from './pagination.js';

export const GENERIC_HTML_ADAPTER_KEY = 'generic-html';

const DIRECTORY_HEADING =
  /\b(staff|faculty|employee|personnel|directory|our team|administration)\b/i;

/**
 * Fallback adapter for directories with no recognizable platform.
 *
 * It scores low on purpose: any platform-specific adapter that recognizes a page
 * should outrank it. Its job is to give useful coverage of the long tail of
 * bespoke district sites rather than to be the best parser for any one of them.
 *
 * Strategies run in descending order of reliability and the first one that
 * yields records wins, so a page with proper JSON-LD is never re-parsed with
 * name-guessing heuristics.
 */
export class GenericHtmlAdapter implements DirectoryAdapter {
  readonly key = GENERIC_HTML_ADAPTER_KEY;
  readonly version = '1.0.0';
  readonly displayName = 'Generic HTML directory';
  readonly detectionThreshold = 0.25;
  readonly requiresBrowser = false;

  detect(context: DetectionContext): DetectionResult {
    const reasons: string[] = [];
    let score = 0;

    const urlScore = scoreDirectoryUrl(context.url);
    if (urlScore.score > 0) {
      score = Math.max(score, urlScore.score * 0.6);
      reasons.push(...urlScore.reasons);
    }

    if (context.page !== null) {
      const $ = loadHtml(context.page.body);

      const headingText = $('h1, h2, title').text();
      if (DIRECTORY_HEADING.test(headingText)) {
        score = Math.max(score, 0.6);
        reasons.push('page heading names a staff directory');
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
      const hasName = headers.some((header) => /name|staff|employee/.test(header));
      const hasDetail = headers.some((header) =>
        /e-?mail|title|position|phone|department/.test(header),
      );
      if (hasName && hasDetail) found = true;
    });
    return found;
  }

  discoverDirectories(page: FetchedPage, context: AdapterContext): readonly DiscoveredDirectory[] {
    const $ = loadHtml(page.body);
    const found = new Map<string, DiscoveredDirectory>();

    $('a[href]').each((_index, element) => {
      const href = $(element).attr('href');
      if (href === undefined) return;
      const resolved = resolveUrl(href, context.baseUrl);
      if (resolved === null) return;

      const label = textOf($, element);
      const urlScore = scoreDirectoryUrl(resolved);
      const labelScore = DIRECTORY_HEADING.test(label) ? 0.7 : 0;
      const score = Math.max(urlScore.score, labelScore);
      if (score < 0.3) return;

      const existing = found.get(resolved);
      if (existing !== undefined && existing.score >= score) return;
      found.set(resolved, {
        url: resolved,
        targetType: context.schoolName === null ? 'district_directory' : 'school_directory',
        sourceType: context.schoolName === null ? 'district_site' : 'school_site',
        score,
        reasons: [...urlScore.reasons, ...(labelScore > 0 ? [`link text "${label}"`] : [])],
      });
    });

    return [...found.values()].sort((a, b) => b.score - a.score);
  }

  extractListing(page: FetchedPage, context: AdapterContext): ListingExtraction {
    const $ = loadHtml(page.body);
    const input = { $, sourceUrl: page.finalUrl, adapterKey: this.key };
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
      const produced = run();
      if (produced.length > 0) {
        records = dedupeExtractedRecords(produced);
        usedStrategy = name;
        break;
      }
    }

    if (usedStrategy === 'mailto' && records.length > 0) {
      warnings.push(
        'fell back to mailto harvesting; records are low confidence and should be reviewed',
      );
    }

    const pagination = discoverPaginationFrom($, page.finalUrl);
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
    if (context.schoolName !== null) out['school'] = context.schoolName;
    if (context.districtName !== null) out['district'] = context.districtName;
    return out;
  }

  extractProfile(page: FetchedPage, _context: AdapterContext): ExtractedPersonRecord | null {
    const $ = loadHtml(page.body);
    const input = { $, sourceUrl: page.finalUrl, adapterKey: this.key };

    const structured = extractStructured(input);
    if (structured.length > 0) return structured[0] ?? null;

    const cards = extractFromCards(input);
    if (cards.length === 1) return cards[0] ?? null;

    const mailto = extractFromMailtoLinks(input);
    return mailto[0] ?? null;
  }

  discoverPagination(page: FetchedPage, _context: AdapterContext): PaginationPlan {
    return discoverPaginationFrom(loadHtml(page.body), page.finalUrl);
  }
}

export const genericHtmlAdapter = new GenericHtmlAdapter();
