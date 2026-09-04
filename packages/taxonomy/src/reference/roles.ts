import { indexByCode, type ReferenceRow } from './types.js';

/**
 * Neutral public-sector job families.
 *
 * Sector packages contribute their own; this list carries no assumption about
 * what kind of public body the worker serves.
 */
export const BASE_JOB_FAMILIES: readonly ReferenceRow[] = [
  { code: 'leadership', name: 'Leadership', description: 'Executive and appointed leadership.' },
  {
    code: 'governance',
    name: 'Governance',
    description: 'Elected officials, board and commission members.',
  },
  {
    code: 'administration',
    name: 'Administration',
    description: 'Administrative and clerical support.',
  },
  {
    code: 'finance',
    name: 'Finance',
    description: 'Budget, accounting, treasury, audit and revenue.',
  },
  { code: 'legal', name: 'Legal', description: 'Counsel, compliance and records law.' },
  {
    code: 'human_resources',
    name: 'Human resources',
    description: 'Recruitment, benefits, payroll and labor relations.',
  },
  {
    code: 'technology',
    name: 'Technology',
    description: 'Information technology, data and cybersecurity.',
  },
  {
    code: 'communications',
    name: 'Communications',
    description: 'Public information, media and outreach.',
  },
  {
    code: 'operations_facilities',
    name: 'Operations and facilities',
    description: 'Buildings, fleet, maintenance and custodial work.',
  },
  {
    code: 'public_safety',
    name: 'Public safety',
    description: 'Law enforcement, fire, emergency medical and emergency management.',
  },
  {
    code: 'health_human_services',
    name: 'Health and human services',
    description: 'Public health, clinical and social services.',
  },
  {
    code: 'engineering_technical',
    name: 'Engineering and technical',
    description: 'Engineering, inspection, surveying and technical trades.',
  },
  {
    code: 'planning_development',
    name: 'Planning and development',
    description: 'Planning, zoning, permitting and economic development.',
  },
  {
    code: 'field_services',
    name: 'Field services',
    description: 'Field, route and site-based service delivery.',
  },
  {
    code: 'research_policy',
    name: 'Research and policy',
    description: 'Analysis, research, evaluation and policy work.',
  },
  {
    code: 'support_services',
    name: 'Support services',
    description: 'Food, transportation and other support functions.',
  },
  { code: 'other', name: 'Other', description: 'A job family not otherwise listed.' },
  { code: 'unknown', name: 'Unknown', description: 'Not determined from the published title.' },
];

export const BASE_JOB_FAMILIES_BY_CODE = indexByCode(BASE_JOB_FAMILIES);

export interface RoleCategoryRow extends ReferenceRow {
  jobFamilyCode: string;
}

/**
 * Neutral role categories.
 *
 * Deliberately covers every kind of public worker, not only decision-makers.
 * Sector packages add the categories their vertical needs.
 */
export const BASE_ROLE_CATEGORIES: readonly RoleCategoryRow[] = [
  {
    code: 'chief_executive',
    name: 'Chief executive',
    description: 'The top appointed or elected executive of an organization.',
    jobFamilyCode: 'leadership',
  },
  {
    code: 'deputy_executive',
    name: 'Deputy executive',
    description: 'Deputy, assistant or associate to the chief executive.',
    jobFamilyCode: 'leadership',
  },
  {
    code: 'department_head',
    name: 'Department head',
    description: 'Head of a department, division or bureau.',
    jobFamilyCode: 'leadership',
  },
  {
    code: 'elected_official',
    name: 'Elected official',
    description: 'A person holding elected office.',
    jobFamilyCode: 'governance',
  },
  {
    code: 'board_member',
    name: 'Board or commission member',
    description: 'Appointed or elected member of a governing body.',
    jobFamilyCode: 'governance',
  },
  {
    code: 'program_manager',
    name: 'Program manager',
    description: 'Manages a program, project or service line.',
    jobFamilyCode: 'leadership',
  },
  {
    code: 'supervisor',
    name: 'Supervisor',
    description: 'First-line supervisor of staff.',
    jobFamilyCode: 'leadership',
  },
  {
    code: 'administrative_support',
    name: 'Administrative support',
    description: 'Secretary, receptionist, clerk or administrative assistant.',
    jobFamilyCode: 'administration',
  },
  {
    code: 'records_clerk',
    name: 'Records and licensing',
    description: 'Records, registration, licensing and permitting clerks.',
    jobFamilyCode: 'administration',
  },
  {
    code: 'finance_accounting',
    name: 'Finance and accounting',
    description: 'Accountants, budget analysts, treasury and payroll staff.',
    jobFamilyCode: 'finance',
  },
  {
    code: 'procurement',
    name: 'Procurement',
    description: 'Purchasing, contracting and vendor management.',
    jobFamilyCode: 'finance',
  },
  {
    code: 'auditor',
    name: 'Auditor',
    description: 'Internal or external audit staff.',
    jobFamilyCode: 'finance',
  },
  {
    code: 'legal_counsel',
    name: 'Legal counsel',
    description: 'Attorneys, paralegals and compliance staff.',
    jobFamilyCode: 'legal',
  },
  {
    code: 'human_resources',
    name: 'Human resources',
    description: 'Recruitment, benefits, classification and labor relations staff.',
    jobFamilyCode: 'human_resources',
  },
  {
    code: 'information_technology',
    name: 'Information technology',
    description: 'Systems, network, application and help-desk staff.',
    jobFamilyCode: 'technology',
  },
  {
    code: 'data_analytics',
    name: 'Data and analytics',
    description: 'Data engineering, analysis and reporting staff.',
    jobFamilyCode: 'technology',
  },
  {
    code: 'communications',
    name: 'Communications',
    description: 'Public information officers, media and web staff.',
    jobFamilyCode: 'communications',
  },
  {
    code: 'law_enforcement',
    name: 'Law enforcement',
    description: 'Sworn officers, deputies, detectives and investigators.',
    jobFamilyCode: 'public_safety',
  },
  {
    code: 'fire_ems',
    name: 'Fire and emergency medical',
    description: 'Firefighters, paramedics and emergency medical technicians.',
    jobFamilyCode: 'public_safety',
  },
  {
    code: 'emergency_management',
    name: 'Emergency management',
    description: 'Emergency preparedness and response coordination.',
    jobFamilyCode: 'public_safety',
  },
  {
    code: 'corrections',
    name: 'Corrections',
    description: 'Detention, corrections and probation staff.',
    jobFamilyCode: 'public_safety',
  },
  {
    code: 'dispatch',
    name: 'Dispatch and communications',
    description: 'Emergency dispatch and telecommunications staff.',
    jobFamilyCode: 'public_safety',
  },
  {
    code: 'public_health',
    name: 'Public health',
    description: 'Epidemiology, inspection, nursing and health program staff.',
    jobFamilyCode: 'health_human_services',
  },
  {
    code: 'social_services',
    name: 'Social services',
    description: 'Case workers, benefits and family services staff.',
    jobFamilyCode: 'health_human_services',
  },
  {
    code: 'engineering',
    name: 'Engineering',
    description: 'Civil, traffic, environmental and structural engineers.',
    jobFamilyCode: 'engineering_technical',
  },
  {
    code: 'inspector',
    name: 'Inspector',
    description: 'Building, health, code and environmental inspectors.',
    jobFamilyCode: 'engineering_technical',
  },
  {
    code: 'planning_zoning',
    name: 'Planning and zoning',
    description: 'Planners, zoning officers and development review staff.',
    jobFamilyCode: 'planning_development',
  },
  {
    code: 'public_works',
    name: 'Public works',
    description: 'Streets, water, sewer and infrastructure crews.',
    jobFamilyCode: 'operations_facilities',
  },
  {
    code: 'facilities_maintenance',
    name: 'Facilities and maintenance',
    description: 'Building maintenance and trades staff.',
    jobFamilyCode: 'operations_facilities',
  },
  {
    code: 'custodial',
    name: 'Custodial',
    description: 'Custodial and grounds staff.',
    jobFamilyCode: 'operations_facilities',
  },
  {
    code: 'transportation_operations',
    name: 'Transportation operations',
    description: 'Drivers, transit operators, fleet and dispatch staff.',
    jobFamilyCode: 'support_services',
  },
  {
    code: 'food_services',
    name: 'Food services',
    description: 'Food preparation and nutrition services staff.',
    jobFamilyCode: 'support_services',
  },
  {
    code: 'parks_recreation',
    name: 'Parks and recreation',
    description: 'Parks, recreation and facility programming staff.',
    jobFamilyCode: 'field_services',
  },
  {
    code: 'library_services',
    name: 'Library services',
    description: 'Librarians and library staff.',
    jobFamilyCode: 'field_services',
  },
  {
    code: 'elections_official',
    name: 'Elections',
    description: 'Election administration and voter services staff.',
    jobFamilyCode: 'administration',
  },
  {
    code: 'field_services',
    name: 'Field services',
    description: 'Route, site and field-based service staff.',
    jobFamilyCode: 'field_services',
  },
  {
    code: 'analyst',
    name: 'Analyst',
    description: 'Policy, program, management or research analysts.',
    jobFamilyCode: 'research_policy',
  },
  {
    code: 'volunteer_community',
    name: 'Volunteer and community',
    description: 'Volunteers, liaisons and community partners.',
    jobFamilyCode: 'support_services',
  },
  {
    code: 'other',
    name: 'Other',
    description: 'A published role that no category yet matches.',
    jobFamilyCode: 'other',
  },
  {
    code: 'unknown',
    name: 'Unknown',
    description: 'No title was published, or it could not be read.',
    jobFamilyCode: 'unknown',
  },
];

export const BASE_ROLE_CATEGORIES_BY_CODE = indexByCode(BASE_ROLE_CATEGORIES);

/** Contact point kinds. Professional only: see docs/SECURITY.md for the boundary. */
export const CONTACT_POINT_TYPES: readonly ReferenceRow[] = [
  {
    code: 'work_email',
    name: 'Work email',
    description: 'A professional email address published by an official source.',
  },
  { code: 'work_phone', name: 'Work phone', description: 'A published office telephone number.' },
  {
    code: 'work_extension',
    name: 'Work extension',
    description: 'A telephone extension within an organization.',
  },
  { code: 'work_fax', name: 'Work fax', description: 'A published office fax number.' },
  {
    code: 'office_address',
    name: 'Office address',
    description: 'A published professional office address.',
  },
  {
    code: 'mailing_address',
    name: 'Official mailing address',
    description: 'A published official mailing address for an organization.',
  },
  {
    code: 'profile_url',
    name: 'Profile page',
    description: 'A public professional profile page on an official site.',
  },
];

export const CONTACT_POINT_TYPES_BY_CODE = indexByCode(CONTACT_POINT_TYPES);
