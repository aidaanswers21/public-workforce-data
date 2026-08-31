import { indexByCode, type ReferenceRow } from './types.js';

/**
 * How a value was pulled off a source.
 *
 * Controlled reference data, not an enum. This list grows every time the
 * platform meets a source format it has not met before: another document type,
 * another API shape, another extraction strategy. Making it an enum would mean
 * a migration each time, and the practical result of that is not a migration.
 * It is a value recorded as `manual` or `other` because writing one was too
 * much trouble, which loses exactly the provenance the column exists for.
 */
export const EXTRACTION_METHODS: readonly ReferenceRow[] = [
  {
    code: 'html_table',
    name: 'HTML table',
    description: 'A table row with a person column and usually a contact column.',
  },
  {
    code: 'html_card',
    name: 'HTML card',
    description: 'A repeated card or tile in a grid of staff.',
  },
  { code: 'html_list', name: 'HTML list', description: 'A repeated list item.' },
  {
    code: 'html_definition_list',
    name: 'HTML definition list',
    description: 'A definition list pairing labels with values.',
  },
  {
    code: 'microdata',
    name: 'Microdata',
    description: 'Schema.org microdata attributes embedded in the markup.',
  },
  {
    code: 'json_ld',
    name: 'JSON-LD',
    description: 'A JSON-LD block declaring people or an organization.',
  },
  { code: 'json_api', name: 'JSON API', description: 'A JSON response from a directory API.' },
  {
    code: 'mailto_harvest',
    name: 'Mailto harvest',
    description: 'A mailto link with the nearest name-shaped text. Low confidence by design.',
  },
  {
    code: 'profile_page',
    name: 'Profile page',
    description: 'A page describing one person rather than a listing.',
  },
  {
    code: 'browser_dom',
    name: 'Browser DOM',
    description: 'Rendered DOM from a headless browser. Not implemented yet.',
  },
  { code: 'pdf_text', name: 'PDF text', description: 'Text extracted from a PDF.' },
  {
    code: 'spreadsheet_row',
    name: 'Spreadsheet row',
    description: 'A row from a spreadsheet or delimited file.',
  },
  {
    code: 'open_data_record',
    name: 'Open data record',
    description: 'A record from an open data portal.',
  },
  {
    code: 'bulk_import',
    name: 'Bulk import',
    description: 'A record from an official bulk dataset.',
  },
  {
    code: 'ai_assisted',
    name: 'Model assisted',
    description:
      'Produced with model assistance. Reserved: nothing writes it, and anything that does must route to review.',
  },
  {
    code: 'file_import',
    name: 'File import',
    description: 'A record imported from an operator-supplied file.',
  },
  { code: 'manual', name: 'Manual entry', description: 'Entered by a person.' },
];

/**
 * How a published address was hidden before it was decoded.
 *
 * Also open: every new anti-harvesting technique is another row. `none` means
 * the address was displayed in plain text.
 */
export const OBFUSCATION_KINDS: readonly ReferenceRow[] = [
  { code: 'none', name: 'None', description: 'Displayed in plain text.' },
  {
    code: 'html_entity',
    name: 'HTML entities',
    description: 'Characters written as numeric or named entities.',
  },
  {
    code: 'at_dot_words',
    name: 'Spelled-out separators',
    description: 'The at sign or dots written as words.',
  },
  {
    code: 'bracketed_at',
    name: 'Bracketed separators',
    description: 'Separators wrapped in brackets or parentheses.',
  },
  {
    code: 'cloudflare_cfemail',
    name: 'Cloudflare email protection',
    description: 'A cfemail attribute holding the encoded address.',
  },
  {
    code: 'data_attribute',
    name: 'Data attribute',
    description: 'The address held in a data attribute rather than the text.',
  },
  {
    code: 'reversed_text',
    name: 'Reversed text',
    description: 'The address written backwards and reversed by CSS or script.',
  },
];

export const EXTRACTION_METHODS_BY_CODE = indexByCode(EXTRACTION_METHODS);
export const OBFUSCATION_KINDS_BY_CODE = indexByCode(OBFUSCATION_KINDS);
