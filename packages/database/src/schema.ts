/** Every table the platform owns. */
export const REFERENCE_TABLE_NAMES = [
  'government_levels',
  'sectors',
  'organization_types',
  'relationship_types',
  'geographic_area_types',
  'identifier_systems',
  'source_types',
  'evidence_classes',
  'job_families',
  'role_categories',
  'seniority_levels',
  'contact_point_types',
  'extraction_methods',
  'obfuscation_kinds',
] as const;

export const TABLE_NAMES = [
  'schema_migrations',
  ...REFERENCE_TABLE_NAMES,
  'crawl_runs',
  'source_policies',
  'directory_platforms',
  'source_documents',
  'source_document_versions',
  'source_observations',
  'geographic_areas',
  'jurisdictions',
  'organizations',
  'organization_relationships',
  'organizational_units',
  'organization_locations',
  'external_identifiers',
  'people',
  'employment_assignments',
  'contact_points',
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
  'education_organization_attributes',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

/**
 * Postgres enum types and the shared-types export each mirrors.
 *
 * Only genuinely closed sets are enums. Anything a vertical might extend is a
 * reference table instead, seeded from `@public-workforce/taxonomy`, so adding an
 * organization type or a role category never needs a migration.
 */
export const ENUM_TYPE_TO_CONSTANT: Readonly<Record<string, string>> = {
  email_classification: 'EMAIL_CLASSIFICATIONS',
  email_validation_status: 'EMAIL_VALIDATION_STATUSES',
  suppression_scope: 'SUPPRESSION_SCOPES',
  suppression_source: 'SUPPRESSION_SOURCES',
  complaint_channel: 'COMPLAINT_CHANNELS',
  complaint_resolution: 'COMPLAINT_RESOLUTIONS',
  assignment_status: 'ASSIGNMENT_STATUSES',
  organization_identity_tier: 'ORGANIZATION_IDENTITY_TIERS',
  collection_status: 'COLLECTION_STATUSES',
  policy_stance: 'POLICY_STANCES',
  crawl_run_status: 'CRAWL_RUN_STATUSES',
  crawl_page_status: 'CRAWL_PAGE_STATUSES',
  crawl_target_status: 'CRAWL_TARGET_STATUSES',
  crawl_target_type: 'CRAWL_TARGET_TYPES',
  crawl_error_type: 'CRAWL_ERROR_TYPES',
  email_candidate_state: 'EMAIL_CANDIDATE_STATES',
  export_status: 'EXPORT_STATUSES',
  record_status: 'RECORD_STATUSES',
  normalization_method: 'NORMALIZATION_METHODS',
};
