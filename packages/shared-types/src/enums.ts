/**
 * Closed vocabularies shared across the platform.
 *
 * Every list here is mirrored by a Postgres enum or CHECK constraint in
 * `supabase/migrations`. `packages/database/src/schema.test.ts` asserts the two
 * stay in sync, so adding a value means touching both sides.
 */

export const EMAIL_CLASSIFICATIONS = [
  /** Explicitly displayed, in plain text, by an official public source. */
  'published',
  /** Publicly displayed but recovered from basic obfuscation (entities, "name at domain dot org", Cloudflare cfemail). */
  'decoded_published',
  /** Generated from a domain pattern. Never observed on a source page. */
  'inferred_candidate',
  /** A shared school/department/office inbox, not attributable to one person. */
  'general_inbox',
  /** Fails syntax or was returned undeliverable by a validation provider. */
  'invalid',
  /** Matched a suppression entry. Retained for audit, never exportable. */
  'suppressed',
] as const;
export type EmailClassification = (typeof EMAIL_CLASSIFICATIONS)[number];

/** Classifications that represent an address a human actually published. */
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
  'ai_assisted',
  'file_import',
  'manual',
] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export const SOURCE_TYPES = [
  'state_agency',
  'district_site',
  'school_site',
  'directory_platform',
  'api',
  'file_import',
  'manual',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SUPPRESSION_SCOPES = [
  'email',
  'domain',
  'person',
  'school',
  'district',
  'state',
  'global',
] as const;
export type SuppressionScope = (typeof SUPPRESSION_SCOPES)[number];

export const SUPPRESSION_SOURCES = [
  'complaint',
  'opt_out_request',
  'legal_request',
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

/**
 * Coarse role buckets. Deliberately covers every staff role, not only
 * decision-makers: the platform is a directory, not a lead filter.
 */
export const ROLE_CATEGORIES = [
  'superintendent',
  'district_leadership',
  'board_member',
  'principal',
  'assistant_principal',
  'school_leadership',
  'teacher',
  'instructional_support',
  'special_education',
  'counselor',
  'psychologist',
  'social_worker',
  'nurse_health',
  'librarian_media',
  'coach_athletics',
  'fine_arts',
  'technology',
  'finance_business',
  'human_resources',
  'communications',
  'operations_facilities',
  'transportation',
  'food_service',
  'safety_security',
  'administrative_support',
  'paraprofessional',
  'custodial',
  'substitute',
  'volunteer_community',
  'other',
  'unknown',
] as const;
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

export const SENIORITY_LEVELS = [
  'executive',
  'director',
  'manager',
  'lead',
  'staff',
  'support',
  'unknown',
] as const;
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];

export const ORG_SCOPES = ['state', 'county', 'district', 'school'] as const;
export type OrgScope = (typeof ORG_SCOPES)[number];

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
  'unsupported_platform',
] as const;
export type CrawlTargetStatus = (typeof CRAWL_TARGET_STATUSES)[number];

export const CRAWL_TARGET_TYPES = [
  'district_site',
  'school_site',
  'district_directory',
  'school_directory',
  'department_directory',
  'profile_page',
  'api_endpoint',
] as const;
export type CrawlTargetType = (typeof CRAWL_TARGET_TYPES)[number];

/**
 * Why the engine stopped walking a directory. Recorded per run so that
 * "we finished" and "we hit a guard" are never confused in coverage reports.
 */
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
