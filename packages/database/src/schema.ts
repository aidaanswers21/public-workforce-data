/** Every table the platform owns, in dependency order. */
export const TABLE_NAMES = [
  'schema_migrations',
  'directory_platforms',
  'crawl_runs',
  'source_pages',
  'source_observations',
  'states',
  'counties',
  'districts',
  'schools',
  'departments',
  'people',
  'employment_assignments',
  'email_addresses',
  'email_candidates',
  'email_validation_results',
  'domain_email_patterns',
  'crawl_targets',
  'crawl_pages',
  'crawl_errors',
  'crawl_checkpoints',
  'suppression_entries',
  'complaints',
  'exports',
  'audit_events',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

/**
 * Postgres enum types and the shared-types export each mirrors.
 *
 * `schema.test.ts` walks this map and fails when the database and the
 * TypeScript vocabulary disagree, which is the failure mode that otherwise
 * shows up as a runtime insert error weeks later.
 */
export const ENUM_TYPE_TO_CONSTANT: Readonly<Record<string, string>> = {
  email_classification: 'EMAIL_CLASSIFICATIONS',
  email_validation_status: 'EMAIL_VALIDATION_STATUSES',
  extraction_method: 'EXTRACTION_METHODS',
  source_type: 'SOURCE_TYPES',
  suppression_scope: 'SUPPRESSION_SCOPES',
  suppression_source: 'SUPPRESSION_SOURCES',
  complaint_channel: 'COMPLAINT_CHANNELS',
  role_category: 'ROLE_CATEGORIES',
  seniority_level: 'SENIORITY_LEVELS',
  org_scope: 'ORG_SCOPES',
  crawl_run_status: 'CRAWL_RUN_STATUSES',
  crawl_page_status: 'CRAWL_PAGE_STATUSES',
  crawl_target_status: 'CRAWL_TARGET_STATUSES',
  crawl_target_type: 'CRAWL_TARGET_TYPES',
  crawl_error_type: 'CRAWL_ERROR_TYPES',
  email_candidate_state: 'EMAIL_CANDIDATE_STATES',
  export_status: 'EXPORT_STATUSES',
  record_status: 'RECORD_STATUSES',
  obfuscation_kind: 'OBFUSCATION_KINDS',
};
