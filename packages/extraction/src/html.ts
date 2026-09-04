import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { collapseWhitespace } from '@public-workforce/core';

export type Html = cheerio.CheerioAPI;
export type { AnyNode };

export function loadHtml(body: string): Html {
  return cheerio.load(body);
}

/** Text content with whitespace collapsed and script/style content removed. */
export function textOf($: Html, element: AnyNode | cheerio.Cheerio<AnyNode>): string {
  const node = isCheerio(element) ? element : $(element);
  const clone = node.clone();
  clone.find('script, style, noscript').remove();
  return collapseWhitespace(clone.text());
}

/** Build a stable-ish CSS path for one element, used as extraction evidence. */
function isCheerio(value: AnyNode | cheerio.Cheerio<AnyNode>): value is cheerio.Cheerio<AnyNode> {
  return typeof (value as cheerio.Cheerio<AnyNode>).clone === 'function';
}

export function selectorFor($: Html, element: AnyNode): string {
  const parts: string[] = [];
  let current = $(element);
  for (let depth = 0; depth < 5 && current.length > 0; depth += 1) {
    const tag = (current.prop('tagName') ?? '').toLowerCase();
    if (tag.length === 0) break;
    const id = current.attr('id');
    if (id !== undefined && id.length > 0) {
      parts.unshift(`${tag}#${id}`);
      break;
    }
    const className = (current.attr('class') ?? '').trim().split(/\s+/).filter(Boolean)[0];
    parts.unshift(className === undefined ? tag : `${tag}.${className}`);
    current = current.parent();
  }
  return parts.join(' > ');
}

/** A trimmed snippet of the source, retained so a human can audit a parse. */
export function snippetOf(text: string, maxLength = 300): string {
  const cleaned = collapseWhitespace(text);
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1)}…`;
}

export type DirectoryField =
  | 'name'
  | 'firstName'
  | 'lastName'
  | 'title'
  | 'email'
  | 'phone'
  | 'extension'
  | 'department'
  | 'organization'
  | 'grade'
  | 'subject'
  | 'location'
  | 'unknown';

/**
 * Map a directory column header to a field.
 *
 * Ordered longest-first inside each group so that "email address" is not
 * matched by a looser "address" rule, and so "last name" wins over "name".
 */
const HEADER_PATTERNS: readonly { pattern: RegExp; field: DirectoryField }[] = [
  { pattern: /^(last\s*name|surname|family\s*name)$/i, field: 'lastName' },
  { pattern: /^(first\s*name|given\s*name)$/i, field: 'firstName' },
  { pattern: /(e-?mail|email\s*address)/i, field: 'email' },
  { pattern: /^(ext\.?|extension)$/i, field: 'extension' },
  { pattern: /(phone|telephone|tel\.?|contact\s*number)/i, field: 'phone' },
  { pattern: /(job\s*title|position|role|assignment|title)/i, field: 'title' },
  { pattern: /(department|dept\.?|team|unit)/i, field: 'department' },
  { pattern: /(grade\s*level|grade|band|level)/i, field: 'grade' },
  { pattern: /(subject|course|content\s*area)/i, field: 'subject' },
  { pattern: /(staff\s*member|employee|full\s*name|^name$|directory)/i, field: 'name' },
];

/**
 * Map a directory column header to a field.
 *
 * Organization column names are supplied by the caller from the composed
 * vocabulary, so a table headed "Campus" and one headed "Bureau" are both
 * understood without this package knowing which vertical either belongs to.
 */
export function classifyHeader(
  header: string,
  organizationTerms: readonly string[] = [],
): DirectoryField {
  const cleaned = collapseWhitespace(header).replace(/[*:]+$/, '');
  if (cleaned.length === 0) return 'unknown';
  for (const { pattern, field } of HEADER_PATTERNS) {
    if (pattern.test(cleaned)) return field;
  }
  const normalized = cleaned.toLowerCase().replace(/[^a-z]+/g, '');
  for (const term of organizationTerms) {
    if (normalized === term.toLowerCase().replace(/[^a-z]+/g, '')) return 'organization';
  }
  return 'unknown';
}

export interface ParsedTable {
  /** Column index to field mapping, derived from the header row. */
  columns: DirectoryField[];
  headers: string[];
  /** Row cells as text, header row excluded. */
  rows: { cells: string[]; html: string; selector: string }[];
  /** 0..1 belief that this table is a staff directory. */
  score: number;
}

/**
 * Parse an HTML table into typed columns.
 *
 * A table only scores as a directory when its header row names at least a
 * person column and one contact or role column. That threshold keeps calendars,
 * fee schedules and bell schedules out of the record set.
 */
export function parseTable(
  $: Html,
  table: AnyNode,
  organizationTerms: readonly string[] = [],
): ParsedTable {
  const $table = $(table);
  const headerCells = $table.find('thead tr').first().find('th, td');
  const fallbackHeader =
    headerCells.length > 0 ? headerCells : $table.find('tr').first().find('th');
  const headers = fallbackHeader.toArray().map((cell) => textOf($, cell));
  const columns = headers.map((header) => classifyHeader(header, organizationTerms));

  const bodyRows = (
    $table.find('tbody tr').length > 0 ? $table.find('tbody tr') : $table.find('tr')
  )
    .toArray()
    .filter((row) => $(row).find('td').length > 0);

  const rows = bodyRows.map((row) => ({
    cells: $(row)
      .find('td, th')
      .toArray()
      .map((cell) => textOf($, cell)),
    html: $.html($(row)) ?? '',
    selector: selectorFor($, row),
  }));

  const hasPerson = columns.some((field) => field === 'name' || field === 'lastName');
  const hasDetail = columns.some(
    (field) =>
      field === 'email' || field === 'title' || field === 'phone' || field === 'department',
  );
  const score = hasPerson && hasDetail ? 0.9 : hasPerson ? 0.5 : 0;

  return { columns, headers, rows, score };
}

/** Recover addresses hidden behind Cloudflare's email obfuscation. */
export function cloudflareEncodedValues($: Html): string[] {
  const values: string[] = [];
  $('[data-cfemail]').each((_index, element) => {
    const value = $(element).attr('data-cfemail');
    if (value !== undefined && value.length > 0) values.push(value);
  });
  $('a.__cf_email__').each((_index, element) => {
    const value = $(element).attr('data-cfemail');
    if (value !== undefined && value.length > 0) values.push(value);
  });
  return values;
}

/** Attribute names some platforms use to hold an address for client-side rendering. */
const EMAIL_ATTRIBUTES = ['data-email', 'data-mail', 'data-contact-email', 'data-staff-email'];

export function emailAttributeValues($: Html, scope?: AnyNode): string[] {
  const values: string[] = [];
  const root = scope === undefined ? $.root() : $(scope);
  for (const attribute of EMAIL_ATTRIBUTES) {
    root.find(`[${attribute}]`).each((_index, element) => {
      const value = $(element).attr(attribute);
      if (value !== undefined && value.includes('@')) values.push(value);
    });
  }
  return values;
}
