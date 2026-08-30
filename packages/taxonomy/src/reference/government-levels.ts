import { indexByCode, type ReferenceRow } from './types.js';

/**
 * Levels of government an organization can belong to.
 *
 * A level is not a hierarchy position: a federal agency is at the federal level
 * whether or not it has a parent, and it never needs a state above it.
 */
export const GOVERNMENT_LEVELS: readonly ReferenceRow[] = [
  { code: 'federal', name: 'Federal', description: 'United States federal government.' },
  { code: 'state', name: 'State', description: 'State or territorial government.' },
  { code: 'county', name: 'County', description: 'County or county-equivalent government.' },
  {
    code: 'municipal',
    name: 'Municipal',
    description: 'City, town, village or borough government.',
  },
  {
    code: 'township',
    name: 'Township',
    description: 'Township or town government where distinct from municipal.',
  },
  {
    code: 'special_district',
    name: 'Special district',
    description:
      'Single-purpose or limited-purpose district, such as water, fire, transit or library.',
  },
  {
    code: 'tribal',
    name: 'Tribal',
    description: 'Federally or state recognized tribal government.',
  },
  {
    code: 'education',
    name: 'Education',
    description:
      'Public education governance, kept distinct because its reporting lines rarely match general government.',
  },
  {
    code: 'other_public_authority',
    name: 'Other public authority',
    description:
      'Public authority, commission, compact or quasi-governmental body that fits no other level.',
  },
];

export const GOVERNMENT_LEVELS_BY_CODE = indexByCode(GOVERNMENT_LEVELS);
export const GOVERNMENT_LEVEL_CODES = GOVERNMENT_LEVELS.map((row) => row.code);
