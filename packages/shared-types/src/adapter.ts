import type { CrawlTargetType, ExtractionMethod, FetchedPage, ObfuscationKind } from './index.js';

/**
 * The words an adapter uses to recognize a directory, a shared inbox and an
 * organizational label.
 *
 * Declared here because it is part of the adapter contract, and composed in
 * `@pan/taxonomy` from a neutral base plus whatever the registered sectors
 * contribute. An adapter reads it without knowing which vertical supplied a
 * given term, which is what lets one adapter serve a school district, a county
 * and a federal bureau.
 */
export interface DirectoryVocabulary {
  headingTerms: readonly string[];
  urlHints: readonly { pattern: string; weight: number }[];
  sharedInboxLocalParts: readonly string[];
  sharedInboxPrefixes: readonly string[];
  organizationLabelWords: readonly string[];
  /**
   * Words that mark a string as a job title rather than a name.
   *
   * Adapters use these to reject a header row or a mis-aligned column without
   * needing the full title rule set, which belongs to the ingestion pipeline.
   */
  titleIndicatorTerms: readonly string[];
  /**
   * Field and column names that identify the organization a row belongs to.
   *
   * Used for JSON keys, table headers and filter controls. A vertical that calls
   * the column "campus" contributes that word here rather than the adapters
   * knowing it.
   */
  organizationFieldAliases: readonly string[];
  organizationNameSuffixes: readonly string[];
}

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
  /** The organization the row named, as published. Any public body, not one kind. */
  organizationPublished: string | null;
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
  | 'organization_filter'
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
  /**
   * Composed from the registered sectors. Required rather than optional, so an
   * adapter can never fall back to a hard-coded word list and quietly become
   * specific to one vertical.
   */
  vocabulary: DirectoryVocabulary;
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
  /** Reference code from the taxonomy, e.g. `html_directory`. */
  sourceTypeCode: string;
  /** 0..1 belief that this URL is a staff directory rather than other content. */
  score: number;
  reasons: readonly string[];
}

export interface ListingExtraction {
  records: readonly ExtractedPersonRecord[];
  pagination: PaginationPlan;
  /** Directory-wide context the page established, such as organization or unit. */
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
  /** The organization whose directory this is, when known. */
  organizationName: string | null;
  /** The organization it belongs to, when known. Never assumed to exist. */
  parentOrganizationName: string | null;
  /** Domains the engine will allow follow-up requests to. */
  allowedDomains: readonly string[];
  /** Composed from the registered sectors. Adapters must not hard-code terms. */
  vocabulary: DirectoryVocabulary;
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
