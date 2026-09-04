import { indexByCode, type ReferenceRow } from './types.js';

/**
 * Kinds of geographic area.
 *
 * Geography is deliberately separate from both jurisdiction and employer
 * hierarchy: an organization can have a federal jurisdiction and an office in a
 * county, and neither fact constrains the other.
 */
export const BASE_GEOGRAPHIC_AREA_TYPES: readonly ReferenceRow[] = [
  { code: 'country', name: 'Country', description: 'A sovereign country.' },
  { code: 'state', name: 'State', description: 'A state of the United States.' },
  {
    code: 'territory',
    name: 'Territory',
    description: 'A territory or commonwealth of the United States.',
  },
  {
    code: 'county',
    name: 'County',
    description: 'A county or county equivalent, including parishes and boroughs.',
  },
  {
    code: 'municipality',
    name: 'Municipality',
    description: 'An incorporated city, town, village or borough.',
  },
  { code: 'township', name: 'Township', description: 'A township or civil town.' },
  { code: 'census_place', name: 'Census place', description: 'A census-designated place.' },
  {
    code: 'zip_code',
    name: 'ZIP code',
    description: 'A United States Postal Service ZIP code area.',
  },
  {
    code: 'congressional_district',
    name: 'Congressional district',
    description: 'A United States congressional district.',
  },
  {
    code: 'metropolitan_area',
    name: 'Metropolitan area',
    description: 'A metropolitan or micropolitan statistical area.',
  },
  {
    code: 'region',
    name: 'Region',
    description: 'A government-defined region that fits no other type.',
  },
];

export const BASE_GEOGRAPHIC_AREA_TYPES_BY_CODE = indexByCode(BASE_GEOGRAPHIC_AREA_TYPES);
