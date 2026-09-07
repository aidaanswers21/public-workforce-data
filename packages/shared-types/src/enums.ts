/**
 * Closed vocabularies.
 *
 * Only genuinely closed sets live here as Postgres enums. Anything a new
 * public-sector vertical might need to extend, such as organization types,
 * sectors, role categories, identifier systems and source types, is controlled
 * reference data in `@public-workforce/taxonomy` instead, so adding one never needs a
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

/**
 * Classes an address can actually be stored as.
 *
 * `email_addresses_observed_only` restricts the table to these plus `invalid`,
 * so ranking an inferred candidate against a stored address would describe a
 * comparison the schema makes impossible.
 */
export type ObservedEmailClassification = Extract<
  EmailClassification,
  'published' | 'decoded_published' | 'general_inbox' | 'invalid'
>;

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

/**
 * `ExtractionMethod` and `ObfuscationKind` deliberately live in `@public-workforce/taxonomy`
 * as controlled reference data, not here.
 *
 * This file holds closed sets: vocabularies the code branches on, where adding
 * a value is a deliberate change of behaviour. How a value was scraped off a
 * page and how an address was hidden are neither. Both grow with every new
 * source format, and a vocabulary that grows on contact with the world belongs
 * in a table, not in a type.
 *
 * They are plain strings here, like `roleCategoryCode` and `sectorCode`
 * elsewhere: the database foreign key and the taxonomy validate them, which is
 * the same guarantee every other reference code gets.
 */
/** A code from the `extraction_methods` reference table. */
export type ExtractionMethod = string;
/** A code from the `obfuscation_kinds` reference table. */
export type ObfuscationKind = string;

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

/**
 * What happened to a complaint.
 *
 * A closed lifecycle, so an enum is right: every complaint is waiting, acted
 * on, waiting for a person, or closed without action. `needs_review` is the one
 * that matters. A phone or postal complaint often arrives without an email
 * address, which is the only thing suppression can match on its own, and the
 * answer to that is a person looking at it, never a suppression row with a null
 * target.
 */
export const COMPLAINT_RESOLUTIONS = [
  'pending',
  'suppressed',
  'needs_review',
  'dismissed',
] as const;
export type ComplaintResolution = (typeof COMPLAINT_RESOLUTIONS)[number];

/** Whether a person currently holds an assignment. */
/**
 * How an organization's identity was resolved, strongest evidence first.
 *
 * Closed, because these are the only kinds of evidence the resolver weighs.
 * `ambiguous` is not a failure: the row exists, it is stable across recrawls,
 * and it is flagged for a person instead of being merged into a look-alike.
 */
export const ORGANIZATION_IDENTITY_TIERS = [
  'official_identifier',
  'source_identifier',
  'parent_scoped_name',
  'domain_scoped_name',
  'ambiguous',
] as const;
export type OrganizationIdentityTier = (typeof ORGANIZATION_IDENTITY_TIERS)[number];

/** Review state for a possible official organization website. */
export const ORGANIZATION_WEBSITE_CANDIDATE_STATUSES = [
  'proposed',
  'verified',
  'rejected',
  'superseded',
] as const;
export type OrganizationWebsiteCandidateStatus =
  (typeof ORGANIZATION_WEBSITE_CANDIDATE_STATUSES)[number];

/**
 * How a website candidate was found.
 *
 * These are evidence classes, not provider names. Adding a new registry or
 * search vendor does not change the workflow or require a schema change.
 */
export const WEBSITE_RESOLUTION_METHODS = [
  'official_identifier_overlay',
  'official_registry_match',
  'official_directory_match',
  'search_result',
  'homepage_redirect',
  'manual',
] as const;
export type WebsiteResolutionMethod = (typeof WEBSITE_RESOLUTION_METHODS)[number];

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

/** Lifecycle of an operator-defined collection scope. */
export const COLLECTION_PROJECT_STATUSES = [
  'draft',
  'active',
  'paused',
  'completed',
  'cancelled',
] as const;
export type CollectionProjectStatus = (typeof COLLECTION_PROJECT_STATUSES)[number];

/** A finite, separately approved release of work inside a project. */
export const COLLECTION_BATCH_STATUSES = [
  'awaiting_approval',
  'queued',
  'running',
  'completed',
  'completed_with_errors',
  'cancelled',
] as const;
export type CollectionBatchStatus = (typeof COLLECTION_BATCH_STATUSES)[number];

/** Durable scheduler state for one target in one approved batch. */
export const COLLECTION_JOB_STATUSES = [
  'queued',
  'claimed',
  'running',
  'completed',
  'failed',
  'policy_hold',
  'cancelled',
] as const;
export type CollectionJobStatus = (typeof COLLECTION_JOB_STATUSES)[number];

/** Discovery finds directories; crawl collects from an already discovered target. */
export const COLLECTION_JOB_KINDS = ['discovery', 'crawl'] as const;
export type CollectionJobKind = (typeof COLLECTION_JOB_KINDS)[number];

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

/** How a published title was turned into a normalized one. */
export const NORMALIZATION_METHODS = [
  'rule_table',
  'exact_match',
  'manual',
  'assisted_review',
] as const;
export type NormalizationMethod = (typeof NORMALIZATION_METHODS)[number];
