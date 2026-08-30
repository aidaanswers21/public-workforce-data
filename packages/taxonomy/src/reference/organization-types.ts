import { indexByCode, type OrganizationTypeRow } from './types.js';

/**
 * What kind of public body an organization is.
 *
 * Extensible by design: this list is seeded into `organization_types` and can
 * grow without a migration. Sector packages contribute their own types through
 * the sector registry rather than editing this file.
 */
export const BASE_ORGANIZATION_TYPES: readonly OrganizationTypeRow[] = [
  {
    code: 'federal_department',
    name: 'Federal department',
    description: 'A cabinet-level department of the United States government.',
    governmentLevelCode: 'federal',
    sectorCode: 'general_government',
    typicallySubordinate: false,
  },
  {
    code: 'federal_agency',
    name: 'Federal agency',
    description: 'A federal agency, independent or within a department.',
    governmentLevelCode: 'federal',
    sectorCode: 'general_government',
    typicallySubordinate: false,
  },
  {
    code: 'federal_bureau',
    name: 'Federal bureau',
    description: 'A bureau, service or administration within a federal agency or department.',
    governmentLevelCode: 'federal',
    sectorCode: 'general_government',
    typicallySubordinate: true,
  },
  {
    code: 'federal_field_office',
    name: 'Federal field office',
    description:
      'A regional, district or local office of a federal body. Its duty location is geographic; its reporting line is not.',
    governmentLevelCode: 'federal',
    sectorCode: 'general_government',
    typicallySubordinate: true,
  },
  {
    code: 'state_agency',
    name: 'State agency',
    description: 'An agency of a state or territorial government.',
    governmentLevelCode: 'state',
    sectorCode: 'general_government',
    typicallySubordinate: false,
  },
  {
    code: 'state_department',
    name: 'State department',
    description: 'A cabinet-level department of a state government.',
    governmentLevelCode: 'state',
    sectorCode: 'general_government',
    typicallySubordinate: false,
  },
  {
    code: 'state_regional_office',
    name: 'State regional office',
    description: 'A regional or district office of a state body.',
    governmentLevelCode: 'state',
    sectorCode: 'general_government',
    typicallySubordinate: true,
  },
  {
    code: 'county_government',
    name: 'County government',
    description: 'A county or county-equivalent government as a whole.',
    governmentLevelCode: 'county',
    sectorCode: 'general_government',
    typicallySubordinate: false,
  },
  {
    code: 'county_department',
    name: 'County department',
    description: 'A department or office within a county government.',
    governmentLevelCode: 'county',
    sectorCode: 'general_government',
    typicallySubordinate: true,
  },
  {
    code: 'municipality',
    name: 'Municipality',
    description: 'A city, town, village or borough government as a whole.',
    governmentLevelCode: 'municipal',
    sectorCode: 'general_government',
    typicallySubordinate: false,
  },
  {
    code: 'municipal_department',
    name: 'Municipal department',
    description: 'A department or office within a municipal government.',
    governmentLevelCode: 'municipal',
    sectorCode: 'general_government',
    typicallySubordinate: true,
  },
  {
    code: 'township_government',
    name: 'Township government',
    description: 'A township or town government where distinct from a municipality.',
    governmentLevelCode: 'township',
    sectorCode: 'general_government',
    typicallySubordinate: false,
  },
  {
    code: 'special_district',
    name: 'Special district',
    description: 'A limited-purpose district such as water, fire, transit, library or hospital.',
    governmentLevelCode: 'special_district',
    sectorCode: 'general_government',
    typicallySubordinate: false,
  },
  {
    code: 'public_authority',
    name: 'Public authority',
    description: 'A public authority, commission or compact operating with its own governance.',
    governmentLevelCode: 'other_public_authority',
    sectorCode: 'general_government',
    typicallySubordinate: false,
  },
  {
    code: 'tribal_government',
    name: 'Tribal government',
    description: 'A recognized tribal government.',
    governmentLevelCode: 'tribal',
    sectorCode: 'general_government',
    typicallySubordinate: false,
  },
  {
    code: 'regional_council',
    name: 'Regional council',
    description:
      'A council of governments or regional planning body spanning several jurisdictions.',
    governmentLevelCode: 'other_public_authority',
    sectorCode: 'general_government',
    typicallySubordinate: false,
  },
  {
    code: 'public_safety_agency',
    name: 'Public safety agency',
    description: 'A police, sheriff, fire or emergency medical agency at any level of government.',
    governmentLevelCode: 'other_public_authority',
    sectorCode: 'public_safety',
    typicallySubordinate: true,
  },
  {
    code: 'other_public_body',
    name: 'Other public body',
    description:
      'A public organization that fits no other type. Use sparingly and prefer adding a type.',
    governmentLevelCode: 'other_public_authority',
    sectorCode: 'other',
    typicallySubordinate: false,
  },
];

export const BASE_ORGANIZATION_TYPES_BY_CODE = indexByCode(BASE_ORGANIZATION_TYPES);
