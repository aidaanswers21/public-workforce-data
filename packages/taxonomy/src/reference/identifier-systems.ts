import { indexByCode, type IdentifierSystemRow } from './types.js';

/**
 * Official identifier systems.
 *
 * Kept generic so identifiers from any level of government coexist on the same
 * table. A sector package registers its own systems rather than this file
 * growing sector-specific knowledge.
 */
export const BASE_IDENTIFIER_SYSTEMS: readonly IdentifierSystemRow[] = [
  {
    code: 'fips_state',
    name: 'FIPS state code',
    description: 'Two digit federal information processing standard code for a state or territory.',
    appliesTo: 'geographic_area',
    pattern: '^\\d{2}$',
    authority: 'U.S. Census Bureau',
  },
  {
    code: 'fips_county',
    name: 'FIPS county code',
    description: 'Five digit state plus county federal information processing standard code.',
    appliesTo: 'geographic_area',
    pattern: '^\\d{5}$',
    authority: 'U.S. Census Bureau',
  },
  {
    code: 'fips_place',
    name: 'FIPS place code',
    description: 'Seven digit state plus place code for an incorporated place.',
    appliesTo: 'geographic_area',
    pattern: '^\\d{7}$',
    authority: 'U.S. Census Bureau',
  },
  {
    code: 'census_geoid',
    name: 'Census GEOID',
    description: 'Census geographic identifier, variable width by area type.',
    appliesTo: 'geographic_area',
    pattern: '^\\d{2,15}$',
    authority: 'U.S. Census Bureau',
  },
  {
    code: 'cgac_agency_code',
    name: 'CGAC agency code',
    description: 'Common Government-wide Accounting Classification agency code.',
    appliesTo: 'organization',
    pattern: '^\\d{3}$',
    authority: 'U.S. Department of the Treasury',
  },
  {
    code: 'omb_agency_code',
    name: 'OMB agency code',
    description: 'Office of Management and Budget agency identifier.',
    appliesTo: 'organization',
    pattern: '^\\d{2,3}$',
    authority: 'U.S. Office of Management and Budget',
  },
  {
    code: 'usaspending_toptier_code',
    name: 'USAspending toptier agency code',
    description: 'Toptier agency code used in federal spending data.',
    appliesTo: 'organization',
    pattern: '^\\d{3,4}$',
    authority: 'U.S. Department of the Treasury',
  },
  {
    code: 'ein',
    name: 'Employer identification number',
    description: 'Federal employer identification number.',
    appliesTo: 'organization',
    pattern: '^\\d{2}-?\\d{7}$',
    authority: 'U.S. Internal Revenue Service',
  },
  {
    code: 'uei',
    name: 'Unique entity identifier',
    description: 'SAM.gov unique entity identifier.',
    appliesTo: 'organization',
    pattern: '^[A-Z0-9]{12}$',
    authority: 'U.S. General Services Administration',
  },
  {
    code: 'state_assigned_id',
    name: 'State assigned identifier',
    description:
      'An identifier a state assigns to an organization. The issuing state is recorded on the row.',
    appliesTo: 'organization',
    pattern: null,
    authority: 'Varies by state',
  },
  {
    code: 'internal_legacy_id',
    name: 'Internal legacy identifier',
    description:
      'An identifier carried from an earlier internal system, retained for traceability.',
    appliesTo: 'organization',
    pattern: null,
    authority: 'Internal',
  },
];

export const BASE_IDENTIFIER_SYSTEMS_BY_CODE = indexByCode(BASE_IDENTIFIER_SYSTEMS);
