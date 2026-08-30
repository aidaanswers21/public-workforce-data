import { indexByCode, type ReferenceRow } from './types.js';

/** Functional area of public work, independent of which level of government does it. */
export const SECTORS: readonly ReferenceRow[] = [
  {
    code: 'general_government',
    name: 'General government',
    description: 'Executive, administrative and central services.',
  },
  { code: 'education', name: 'Education', description: 'Public education at any level.' },
  {
    code: 'public_safety',
    name: 'Public safety',
    description: 'Law enforcement, fire, emergency medical and emergency management.',
  },
  {
    code: 'health_human_services',
    name: 'Health and human services',
    description: 'Public health, social services and benefits administration.',
  },
  {
    code: 'transportation',
    name: 'Transportation',
    description: 'Roads, transit, aviation, ports and vehicle administration.',
  },
  { code: 'utilities', name: 'Utilities', description: 'Water, sewer, power and waste services.' },
  {
    code: 'environment',
    name: 'Environment and natural resources',
    description: 'Environmental protection, parks, wildlife and land management.',
  },
  {
    code: 'finance_revenue',
    name: 'Finance and revenue',
    description: 'Budget, treasury, tax and audit functions.',
  },
  { code: 'judicial', name: 'Judicial', description: 'Courts and court administration.' },
  {
    code: 'legislative',
    name: 'Legislative',
    description: 'Legislative bodies and their staff offices.',
  },
  {
    code: 'workforce_labor',
    name: 'Workforce and labor',
    description: 'Employment services, labor standards and workforce development.',
  },
  {
    code: 'housing_community',
    name: 'Housing and community development',
    description: 'Housing authorities, planning and community development.',
  },
  {
    code: 'parks_recreation',
    name: 'Parks and recreation',
    description: 'Parks, recreation and community facilities.',
  },
  {
    code: 'library_culture',
    name: 'Library and culture',
    description: 'Libraries, museums and cultural affairs.',
  },
  {
    code: 'elections',
    name: 'Elections',
    description: 'Election administration and voter services.',
  },
  { code: 'other', name: 'Other', description: 'A public function that fits no other sector.' },
];

export const SECTORS_BY_CODE = indexByCode(SECTORS);
export const SECTOR_CODES = SECTORS.map((row) => row.code);
