-- Closed vocabularies. Mirrored by packages/shared-types/src/enums.ts and kept
-- in sync by packages/database/src/schema.test.ts, which fails if either side
-- gains a value the other lacks.

create type email_classification as enum (
  'published', 'decoded_published', 'inferred_candidate', 'general_inbox', 'invalid', 'suppressed'
);

create type email_validation_status as enum (
  'unvalidated', 'valid', 'invalid', 'risky', 'accept_all', 'unknown', 'error'
);

create type extraction_method as enum (
  'html_table', 'html_card', 'html_list', 'html_definition_list', 'microdata', 'json_ld',
  'json_api', 'mailto_harvest', 'profile_page', 'browser_dom', 'ai_assisted', 'file_import', 'manual'
);

create type source_type as enum (
  'state_agency', 'district_site', 'school_site', 'directory_platform', 'api', 'file_import', 'manual'
);

create type suppression_scope as enum (
  'email', 'domain', 'person', 'school', 'district', 'state', 'global'
);

create type suppression_source as enum (
  'complaint', 'opt_out_request', 'legal_request', 'bounce', 'manual_review', 'policy', 'import'
);

create type complaint_channel as enum ('email', 'phone', 'web_form', 'mail', 'regulator', 'other');

create type role_category as enum (
  'superintendent', 'district_leadership', 'board_member', 'principal', 'assistant_principal',
  'school_leadership', 'teacher', 'instructional_support', 'special_education', 'counselor',
  'psychologist', 'social_worker', 'nurse_health', 'librarian_media', 'coach_athletics', 'fine_arts',
  'technology', 'finance_business', 'human_resources', 'communications', 'operations_facilities',
  'transportation', 'food_service', 'safety_security', 'administrative_support', 'paraprofessional',
  'custodial', 'substitute', 'volunteer_community', 'other', 'unknown'
);

create type seniority_level as enum ('executive', 'director', 'manager', 'lead', 'staff', 'support', 'unknown');

create type org_scope as enum ('state', 'county', 'district', 'school');

create type crawl_run_status as enum (
  'queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled'
);

create type crawl_page_status as enum ('pending', 'fetched', 'parsed', 'skipped', 'failed', 'blocked');

create type crawl_target_status as enum (
  'pending', 'discovering', 'ready', 'crawling', 'crawled', 'failed', 'blocked', 'excluded', 'unsupported_platform'
);

create type crawl_target_type as enum (
  'district_site', 'school_site', 'district_directory', 'school_directory',
  'department_directory', 'profile_page', 'api_endpoint'
);

create type crawl_error_type as enum (
  'network', 'timeout', 'http_error', 'parse_error', 'adapter_error', 'robots_disallowed',
  'blocked_by_source', 'requires_authentication', 'captcha', 'unsupported_platform', 'policy_violation', 'internal'
);

create type email_candidate_state as enum ('pending', 'validated', 'promoted', 'rejected', 'suppressed');

create type export_status as enum ('requested', 'building', 'completed', 'failed', 'blocked');

create type record_status as enum ('active', 'inactive', 'unconfirmed');

create type obfuscation_kind as enum (
  'none', 'html_entity', 'at_dot_words', 'bracketed_at', 'cloudflare_cfemail', 'data_attribute', 'reversed_text'
);
