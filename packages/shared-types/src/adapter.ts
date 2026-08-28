import type {
  CrawlTargetType,
  ExtractionMethod,
  FetchedPage,
  ObfuscationKind,
  SourceType,
} from './index.js';

/** An email exactly as found on a page, plus how it was recovered. */
export interface ExtractedEmail {
  /** Raw text as displayed, before decoding. */
  raw: string;
  /** Decoded, lowercased address. */
  address: string;
  obfuscation: ObfuscationKind;
  /** Adapter's hint. `classifyEmail` in @pan/core makes the final call. */
  looksLikeGeneralInbox: boolean;
}

/**
 * One person as published on one page.
 *
 * Adapters return only what the page said. Name splitting, title normalization,
 * classification and identity resolution all happen downstream in @pan/core, so
 * an adapter can never quietly invent structure the source did not contain.
 */
export interface ExtractedPersonRecord {
  /**
   * Deterministic within (adapter, sourceUrl). Recomputing it on a later crawl
   * of the same page must produce the same value. This is what makes recrawls
   * idempotent.
   */
  recordKey: string;
  fullNamePublished: string;
  titlePublished: string | null;
  departmentPublished: string | null;
  schoolPublished: string | null;
  phonePublished: string | null;
  emails: readonly ExtractedEmail[];
  profileUrl: string | null;
  extractionMethod: ExtractionMethod;
  /** 0..1. Adapter's own confidence in this row being a real staff record. */
  confidence: number;
  /** Selector or JSON pointer the record came from, for debugging and audit. */
  selector: string | null;
  /** Verbatim source snippet, trimmed. Retained so a human can check the parse. */
  snippet: string | null;
}

export type PaginationKind =
  | 'numbered'
  | 'next_link'
  | 'offset_param'
  | 'page_param'
  | 'cursor_api'
  | 'load_more'
  | 'infinite_scroll'
  | 'alpha_filter'
  | 'department_filter'
  | 'school_filter'
  | 'search_interface';

/** One concrete follow-up request the engine may enqueue. */
export interface PaginationRequest {
  url: string;
  kind: PaginationKind;
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  /**
   * Opaque, stable identity for this pagination step (page number, cursor,
   * letter). The engine refuses to visit the same token twice, which is the
   * primary loop guard.
   */
  token: string;
  context?: Record<string, unknown>;
}

export interface PaginationPlan {
  kind: PaginationKind | null;
  requests: readonly PaginationRequest[];
  /** Adapter's own belief that no further pages exist. */
  exhausted: boolean;
  note: string | null;
}

export interface DetectionContext {
  url: string;
  page: FetchedPage | null;
  /** Hints from discovery: link text, heading text, platform fingerprints. */
  hints: Readonly<Record<string, string>>;
}

export interface DetectionResult {
  adapterKey: string;
  /** 0..1. The registry picks the highest score above the adapter's threshold. */
  score: number;
  platformKey: string | null;
  reasons: readonly string[];
}

export interface DiscoveredDirectory {
  url: string;
  targetType: CrawlTargetType;
  sourceType: SourceType;
  /** 0..1 belief that this URL is a staff directory rather than other content. */
  score: number;
  reasons: readonly string[];
}

export interface ListingExtraction {
  records: readonly ExtractedPersonRecord[];
  pagination: PaginationPlan;
  /** Directory-wide context the page established (school name, department). */
  context: Readonly<Record<string, string>>;
  /**
   * True when the page parsed fine and genuinely holds no people. Distinct from
   * a failed parse, so the engine can tell "empty page" from "broken adapter".
   */
  empty: boolean;
  warnings: readonly string[];
}

export interface AdapterContext {
  /** Absolute URL the page was fetched from, used to resolve relative links. */
  baseUrl: string;
  districtName: string | null;
  schoolName: string | null;
  /** Domains the engine will allow follow-up requests to. */
  allowedDomains: readonly string[];
  now: () => Date;
}

/**
 * The contract every directory platform integration implements.
 *
 * A new platform is added by implementing this interface and registering it.
 * Nothing in the crawl engine, normalization pipeline or state configuration
 * needs to change. `runAdapterContractTests` in @pan/adapter-kit enforces the
 * behavioural half of the contract that types cannot express.
 */
export interface DirectoryAdapter {
  readonly key: string;
  readonly version: string;
  readonly displayName: string;
  /** Minimum detection score at which this adapter claims a page. */
  readonly detectionThreshold: number;
  /** True when the adapter needs a rendered DOM rather than raw HTML. */
  readonly requiresBrowser: boolean;

  detect(ctx: DetectionContext): DetectionResult;
  discoverDirectories(page: FetchedPage, ctx: AdapterContext): readonly DiscoveredDirectory[];
  extractListing(page: FetchedPage, ctx: AdapterContext): ListingExtraction;
  extractProfile(page: FetchedPage, ctx: AdapterContext): ExtractedPersonRecord | null;
  discoverPagination(page: FetchedPage, ctx: AdapterContext): PaginationPlan;
}
