import { indexByCode, type ReferenceRow } from './types.js';

/**
 * Kinds of source a record can come from.
 *
 * The platform reads far more than directory web pages. Treating an open-data
 * portal or a published spreadsheet as a first-class source is what lets
 * employment evidence and contact evidence come from different places.
 */
export const SOURCE_TYPES: readonly ReferenceRow[] = [
  {
    code: 'html_directory',
    name: 'HTML directory',
    description: 'A staff or personnel directory rendered as HTML.',
  },
  {
    code: 'search_directory',
    name: 'Search-driven directory',
    description: 'A directory reachable only through a search form.',
  },
  { code: 'api', name: 'API', description: 'A documented programmatic interface.' },
  {
    code: 'json_endpoint',
    name: 'JSON endpoint',
    description: 'An undocumented JSON endpoint backing a page.',
  },
  { code: 'csv', name: 'CSV file', description: 'A published comma or tab separated file.' },
  { code: 'spreadsheet', name: 'Spreadsheet', description: 'A published spreadsheet workbook.' },
  {
    code: 'open_data_portal',
    name: 'Open data portal',
    description: 'A government open-data catalogue entry or dataset.',
  },
  {
    code: 'pdf',
    name: 'PDF document',
    description: 'A published PDF, such as a roster or budget appendix.',
  },
  {
    code: 'org_chart',
    name: 'Organizational chart',
    description: 'A published organizational chart.',
  },
  {
    code: 'agency_contact_page',
    name: 'Agency contact page',
    description: 'A contact or leadership page rather than a full directory.',
  },
  {
    code: 'bulk_dataset',
    name: 'Bulk official dataset',
    description: 'A bulk download published by a government body.',
  },
  {
    code: 'press_release',
    name: 'Official announcement',
    description: 'An official announcement naming an appointment or role.',
  },
  {
    code: 'manual_entry',
    name: 'Manual entry',
    description: 'Recorded by a person, with the reason noted.',
  },
  {
    code: 'other',
    name: 'Other public professional source',
    description: 'A public source that fits no other type.',
  },
];

export const SOURCE_TYPES_BY_CODE = indexByCode(SOURCE_TYPES);

/**
 * What a source proves.
 *
 * One source may establish that a person works for an organization while a
 * different one supplies their address. Keeping the two apart means a contact
 * detail can be revised without disturbing the employment evidence, and either
 * can be traced on its own.
 */
export const EVIDENCE_CLASSES: readonly ReferenceRow[] = [
  {
    code: 'organization',
    name: 'Organization evidence',
    description: 'Establishes that an organization exists, or its type, name or hierarchy.',
  },
  {
    code: 'employment',
    name: 'Employment evidence',
    description: 'Establishes that a person holds a role at an organization.',
  },
  {
    code: 'contact',
    name: 'Contact evidence',
    description: 'Establishes a professional contact point for a person or organization.',
  },
  {
    code: 'location',
    name: 'Location evidence',
    description: 'Establishes an office or duty location.',
  },
  {
    code: 'policy',
    name: 'Policy evidence',
    description: 'Records a source policy statement, such as terms of use.',
  },
];

export const EVIDENCE_CLASSES_BY_CODE = indexByCode(EVIDENCE_CLASSES);
export const EVIDENCE_CLASS_CODES = EVIDENCE_CLASSES.map((row) => row.code);
