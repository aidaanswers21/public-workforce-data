/**
 * Closed vocabularies.
 *
 * Only genuinely closed sets live here as Postgres enums. Anything a new
 * public-sector vertical might need to extend, such as organization types,
 * sectors, role categories, identifier systems and source types, is controlled
 * reference data in `@pan/taxonomy` instead, so adding one never needs a
 * migration. `packages/database/src/schema.test.ts` keeps this file and the
 * database enums in step.
 */

export const EMAIL_CLASSIFICATIONS = [
  /** Explicitly displayed, in plain text, by an official public source. */
  'published',
  /** Publicly displayed but recovered from basic obfuscation. */
  'decoded_published',
  /** Generated from a domain pattern. Never observed on a source page. */
  'inferred_candidate',
  /** A shared organizational inbox, not attributable to one person. */
  'general_inbox',
  /** Fails syntax, or a provider returned undeliverable. */
  'invalid',
  /** Matched a suppression entry. Retained for audit, never exportable. */
  'suppressed',
] as const;
export type EmailClassification = (typeof EMAIL_CLASSIFICATIONS)[number];

export const OBSERVED_EMAIL_CLASSIFICATIONS = [
  'published',
  'decoded_published',
  'general_inbox',
] as const satisfies readonly EmailClassification[];

export const EMAIL_VALIDATION_STATUSES = [
  'unvalidated',
  'valid',
  'invalid',
  'risky',
  'accept_all',
  'unknown',
  'error',
] as const;
export type EmailValidationStatus = (typeof EMAIL_VALIDATION_STATUSES)[number];

export const EXTRACTION_METHODS = [
  'html_table',
  'html_card',
  'html_list',
  'html_definition_list',
  'microdata',
  'json_ld',
  'json_api',
  'mailto_harvest',
  'profile_page',
  'browser_dom',
  'pdf_text',
  'spreadsheet_row',
  'open_data_record',
  'bulk_import',
  'ai_assisted',
  'file_import',
  'manual',
] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/**
 * What a suppression entry covers.
 *
 * `organization_subtree` rolls down through every containment relationship, so
 * suppressing a parent organization also suppresses every organization beneath
 * it. Oversight relationships are excluded: a regulator does not employ the
 * staff of the bodies it regulates.
 */
export const SUPPRESSION_SCOPES = [
  'person',
  'email',
  'domain',
  'organization',
  'organization_subtree',
  'source',
  'jurisdiction',
  'government_level',
  'geographic_area',
  'export_purpose',
  'global',
] as const;
export type SuppressionScope = (typeof SUPPRESSION_SCOPES)[number];

export const SUPPRESSION_SOURCES = [
  'complaint',
  'opt_out_request',
  'legal_request',
  'source_policy',
  'bounce',
  'manual_review',
  'policy',
  'import',
] as const;
export type SuppressionSource = (typeof SUPPRESSION_SOURCES)[number];

export const COMPLAINT_CHANNELS = [
  'email',
  'phone',
  'web_form',
  'mail',
  'regulator',
  'other',
] as const;
export type ComplaintChannel = (typeof COMPLAINT_CHANNELS)[number];

/** Whether a person currently holds an assignment. */
export const ASSIGNMENT_STATUSES = ['active', 'inactive', 'historical', 'unknown'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** Whether we may collect from a source at all. */
export const COLLECTION_STATUSES = [
  'permitted',
  'prohibited',
  'review_required',
  'unknown',
] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

/** Whether a stated policy allows a particular downstream use. */
export const POLICY_STANCES = ['permitted', 'prohibited', 'restricted', 'unknown'] as const;
export type PolicyStance = (typeof POLICY_STANCES)[number];

export const CRAWL_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
] as const;
export type CrawlRunStatus = (typeof CRAWL_RUN_STATUSES)[number];

export const CRAWL_PAGE_STATUSES = [
  'pending',
  'fetched',
  'parsed',
  'skipped',
  'failed',
  'blocked',
] as const;
export type CrawlPageStatus = (typeof CRAWL_PAGE_STATUSES)[number];

export const CRAWL_TARGET_STATUSES = [
  'pending',
  'discovering',
  'ready',
  'crawling',
  'crawled',
  'failed',
  'blocked',
  'excluded',
  'policy_hold',
  'unsupported_platform',
] as const;
export type CrawlTargetStatus = (typeof CRAWL_TARGET_STATUSES)[number];

export const CRAWL_TARGET_TYPES = [
  'organization_site',
  'organization_directory',
  'unit_directory',
  'profile_page',
  'api_endpoint',
  'dataset',
  'document',
] as const;
export type CrawlTargetType = (typeof CRAWL_TARGET_TYPES)[number];

export const CRAWL_STOP_REASONS = [
  'completed',
  'page_budget_exhausted',
  'domain_budget_exhausted',
  'depth_limit',
  'pagination_loop',
  'duplicate_content',
  'no_progress',
  'empty_success',
  'repeated_failures',
  'blocked_by_robots',
  'blocked_by_source',
  'blocked_by_source_policy',
  'excluded_by_policy',
  'cancelled',
] as const;
export type CrawlStopReason = (typeof CRAWL_STOP_REASONS)[number];

export const CRAWL_ERROR_TYPES = [
  'network',
  'timeout',
  'http_error',
  'parse_error',
  'adapter_error',
  'robots_disallowed',
  'blocked_by_source',
  'source_policy_refusal',
  'requires_authentication',
  'captcha',
  'unsupported_platform',
  'policy_violation',
  'internal',
] as const;
export type CrawlErrorType = (typeof CRAWL_ERROR_TYPES)[number];

export const EMAIL_CANDIDATE_STATES = [
  'pending',
  'validated',
  'promoted',
  'rejected',
  'suppressed',
] as const;
export type EmailCandidateState = (typeof EMAIL_CANDIDATE_STATES)[number];

export const EXPORT_STATUSES = ['requested', 'building', 'completed', 'failed', 'blocked'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const RECORD_STATUSES = ['active', 'inactive', 'unconfirmed'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const OBFUSCATION_KINDS = [
  'none',
  'html_entity',
  'at_dot_words',
  'bracketed_at',
  'cloudflare_cfemail',
  'data_attribute',
  'reversed_text',
] as const;
export type ObfuscationKind = (typeof OBFUSCATION_KINDS)[number];

/** How a published title was turned into a normalized one. */
export const NORMALIZATION_METHODS = [
  'rule_table',
  'exact_match',
  'manual',
  'assisted_review',
] as const;
export type NormalizationMethod = (typeof NORMALIZATION_METHODS)[number];
