import type { ExtractedPersonRecord } from '@pan/shared-types';
import { collapseWhitespace, looksLikeTitle, normalizePhone } from '@pan/core';
import {
  classifyHeader,
  cloudflareEncodedValues,
  emailAttributeValues,
  parseTable,
  selectorFor,
  snippetOf,
  textOf,
  type DirectoryField,
  type Html,
} from '@pan/extraction';
import { extractJsonLdPersons, extractMicrodataPersons } from '@pan/extraction';
import { buildPersonRecord, looksLikePersonName } from '@pan/adapter-kit';

export interface ExtractInput {
  $: Html;
  sourceUrl: string;
  adapterKey: string;
}

/** Structured markup first: the site has already told us what each value means. */
export function extractStructured(input: ExtractInput): ExtractedPersonRecord[] {
  const records: ExtractedPersonRecord[] = [];
  const structured = [...extractJsonLdPersons(input.$), ...extractMicrodataPersons(input.$)];

  structured.forEach((person, index) => {
    const record = buildPersonRecord({
      adapterKey: input.adapterKey,
      sourceUrl: input.sourceUrl,
      localKey: person.email ?? `${person.name}#${index}`,
      fullNamePublished: person.name,
      titlePublished: person.title,
      departmentPublished: person.department,
      schoolPublished: person.affiliation,
      phonePublished: person.telephone,
      emailSources: person.email === null ? [] : [person.email],
      extractionMethod: person.source === 'json_ld' ? 'json_ld' : 'microdata',
      confidence: 0.95,
      selector:
        person.source === 'json_ld' ? 'script[type="application/ld+json"]' : '[itemtype*="Person"]',
      snippet: snippetOf(`${person.name} ${person.title ?? ''}`),
    });
    if (record !== null) records.push(record);
  });

  return records;
}

/** Tabular directories: the most common and the most reliable HTML form. */
export function extractFromTables(input: ExtractInput): ExtractedPersonRecord[] {
  const records: ExtractedPersonRecord[] = [];

  input.$('table').each((tableIndex, table) => {
    const parsed = parseTable(input.$, table);
    if (parsed.score < 0.5) return;

    parsed.rows.forEach((row, rowIndex) => {
      const byField = new Map<DirectoryField, string[]>();
      row.cells.forEach((cell, columnIndex) => {
        const field = parsed.columns[columnIndex] ?? 'unknown';
        const bucket = byField.get(field);
        if (bucket) bucket.push(cell);
        else byField.set(field, [cell]);
      });

      const first = (field: DirectoryField): string | null => byField.get(field)?.[0] ?? null;
      const explicitName = first('name');
      const composed =
        explicitName ??
        [first('firstName'), first('lastName')]
          .filter((part) => part !== null && part.length > 0)
          .join(' ');
      if (composed.length === 0 || !looksLikePersonName(composed)) return;

      const rowHtml = row.html;
      const emailSources = [
        ...(byField.get('email') ?? []),
        ...collectHrefEmails(input.$, rowHtml),
        ...collectAttributeEmails(input.$, rowHtml),
      ];

      const record = buildPersonRecord({
        adapterKey: input.adapterKey,
        sourceUrl: input.sourceUrl,
        localKey: `table${tableIndex}:row${rowIndex}:${composed}`,
        fullNamePublished: composed,
        titlePublished: first('title'),
        departmentPublished: first('department'),
        schoolPublished: first('school'),
        phonePublished: first('phone'),
        emailSources,
        cloudflareEncoded: collectCfEmails(input.$, rowHtml),
        profileUrl: firstProfileHref(input.$, rowHtml),
        extractionMethod: 'html_table',
        confidence: parsed.score,
        selector: row.selector,
        snippet: snippetOf(row.cells.join(' | ')),
      });
      if (record !== null) records.push(record);
    });
  });

  return records;
}

const CARD_CONTAINER_SELECTORS = [
  '[class*="staff" i]',
  '[class*="faculty" i]',
  '[class*="directory" i]',
  '[class*="employee" i]',
  '[class*="person" i]',
  '[class*="team-member" i]',
  '[class*="profile" i]',
  'li',
  'article',
];

/**
 * Card and list directories.
 *
 * Groups of sibling elements sharing a tag and class are treated as repeated
 * records when at least three of them contain something name-shaped plus a
 * contact or role value. Requiring three keeps a page's header, footer and
 * sidebar from being mistaken for a roster.
 */
export function extractFromCards(input: ExtractInput): ExtractedPersonRecord[] {
  const { $ } = input;
  const groups = new Map<string, { elements: ReturnType<Html>[]; selector: string }>();

  for (const selector of CARD_CONTAINER_SELECTORS) {
    $(selector).each((_index, element) => {
      const node = $(element);
      const tag = (node.prop('tagName') ?? '').toLowerCase();
      const className = (node.attr('class') ?? '').trim().split(/\s+/).filter(Boolean)[0] ?? '';
      const parentPath = selectorFor($, element);
      const key = `${tag}.${className}@${parentPath.split(' > ').slice(0, -1).join(' > ')}`;
      const entry = groups.get(key);
      if (entry) entry.elements.push(node);
      else
        groups.set(key, {
          elements: [node],
          selector: `${tag}${className ? `.${className}` : ''}`,
        });
    });
  }

  const records: ExtractedPersonRecord[] = [];
  const seenLocalKeys = new Set<string>();

  for (const [, group] of groups) {
    if (group.elements.length < 3) continue;

    group.elements.forEach((node, index) => {
      const html = $.html(node) ?? '';
      const emailSources = collectHrefEmails($, html);
      const attributeEmails = emailAttributeValues($, node.get(0));
      const cfEmails = collectCfEmails($, html);
      const text = textOf($, node);
      const inlineEmails = /@/.test(text) ? [text] : [];

      const hasContact =
        emailSources.length > 0 ||
        attributeEmails.length > 0 ||
        cfEmails.length > 0 ||
        inlineEmails.length > 0;

      const name = guessNameWithin($, node);
      if (name === null) return;
      const title = guessTitleWithin($, node, name);
      if (!hasContact && title === null) return;

      const localKey = `card:${name}#${index}`;
      if (seenLocalKeys.has(localKey)) return;
      seenLocalKeys.add(localKey);

      const record = buildPersonRecord({
        adapterKey: input.adapterKey,
        sourceUrl: input.sourceUrl,
        localKey,
        fullNamePublished: name,
        titlePublished: title,
        phonePublished: guessPhoneWithin(text),
        emailSources: [...emailSources, ...attributeEmails, ...inlineEmails],
        cloudflareEncoded: cfEmails,
        profileUrl: firstProfileHref($, html),
        extractionMethod: group.selector === 'li' ? 'html_list' : 'html_card',
        confidence: hasContact ? 0.8 : 0.6,
        selector: group.selector,
        snippet: snippetOf(text),
      });
      if (record !== null) records.push(record);
    });

    if (records.length > 0) break;
  }

  return records;
}

/** Definition-list directories: <dt>Name</dt><dd>Title, email</dd>. */
export function extractFromDefinitionLists(input: ExtractInput): ExtractedPersonRecord[] {
  const { $ } = input;
  const records: ExtractedPersonRecord[] = [];

  $('dl').each((listIndex, list) => {
    const terms = $(list).find('dt').toArray();
    if (terms.length < 2) return;
    terms.forEach((term, index) => {
      const name = textOf($, term);
      if (!looksLikePersonName(name)) return;
      const definition = $(term).next('dd');
      if (definition.length === 0) return;
      const html = $.html(definition) ?? '';
      const text = textOf($, definition);
      const record = buildPersonRecord({
        adapterKey: input.adapterKey,
        sourceUrl: input.sourceUrl,
        localKey: `dl${listIndex}:${index}:${name}`,
        fullNamePublished: name,
        titlePublished: firstTitleLike(text),
        phonePublished: guessPhoneWithin(text),
        emailSources: [...collectHrefEmails($, html), text],
        cloudflareEncoded: collectCfEmails($, html),
        extractionMethod: 'html_definition_list',
        confidence: 0.7,
        selector: 'dl > dt + dd',
        snippet: snippetOf(`${name}: ${text}`),
      });
      if (record !== null) records.push(record);
    });
  });

  return records;
}

/**
 * Last resort: harvest mailto links and attribute the nearest name to each.
 *
 * Confidence is deliberately low. These records exist so that a page whose
 * markup we cannot parse still yields something reviewable, not so that they can
 * be exported without a human ever looking at them.
 */
export function extractFromMailtoLinks(input: ExtractInput): ExtractedPersonRecord[] {
  const { $ } = input;
  const records: ExtractedPersonRecord[] = [];

  $('a[href^="mailto:" i]').each((index, element) => {
    const href = $(element).attr('href');
    if (href === undefined) return;
    const linkText = textOf($, element);
    const container = $(element).closest('li, td, tr, div, p, article, section').first();
    const containerText = container.length > 0 ? textOf($, container) : linkText;

    const name = looksLikePersonName(linkText)
      ? linkText
      : (guessNameWithin($, container.length > 0 ? container : $(element)) ?? null);
    if (name === null) return;

    const record = buildPersonRecord({
      adapterKey: input.adapterKey,
      sourceUrl: input.sourceUrl,
      localKey: `mailto:${href}#${index}`,
      fullNamePublished: name,
      titlePublished: firstTitleLike(containerText),
      phonePublished: guessPhoneWithin(containerText),
      emailSources: [href],
      extractionMethod: 'mailto_harvest',
      confidence: 0.45,
      selector: 'a[href^="mailto:"]',
      snippet: snippetOf(containerText),
    });
    if (record !== null) records.push(record);
  });

  return records;
}

function collectHrefEmails($: Html, html: string): string[] {
  const fragment = $.load(html);
  const out: string[] = [];
  fragment('a[href^="mailto:" i]').each((_index, element) => {
    const href = fragment(element).attr('href');
    if (href !== undefined) out.push(href);
  });
  return out;
}

function collectAttributeEmails($: Html, html: string): string[] {
  return emailAttributeValues($.load(html));
}

function collectCfEmails($: Html, html: string): string[] {
  return cloudflareEncodedValues($.load(html));
}

function firstProfileHref($: Html, html: string): string | null {
  const fragment = $.load(html);
  let found: string | null = null;
  fragment('a[href]').each((_index, element) => {
    if (found !== null) return;
    const href = fragment(element).attr('href');
    if (href === undefined) return;
    if (/^(mailto:|tel:|#|javascript:)/i.test(href)) return;
    if (!/(staff|profile|bio|person|employee|directory|teacher|user)/i.test(href)) return;
    found = href;
  });
  return found;
}

const NAME_SELECTORS = [
  '[class*="name" i]',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'strong',
  'b',
  'a[href]',
];

function guessNameWithin($: Html, node: ReturnType<Html>): string | null {
  for (const selector of NAME_SELECTORS) {
    const candidate = node.find(selector).first();
    if (candidate.length === 0) continue;
    const text = textOf($, candidate);
    if (looksLikePersonName(text) && !looksLikeTitle(text)) return text;
  }
  const own = textOf($, node);
  const firstLine = own.split(/[|,•]/)[0] ?? '';
  return looksLikePersonName(firstLine) && !looksLikeTitle(firstLine)
    ? collapseWhitespace(firstLine)
    : null;
}

function guessTitleWithin($: Html, node: ReturnType<Html>, name: string): string | null {
  const explicit = node
    .find('[class*="title" i], [class*="position" i], [class*="role" i], [class*="job" i]')
    .first();
  if (explicit.length > 0) {
    const text = textOf($, explicit);
    if (text.length > 0 && text !== name) return text;
  }
  const text = textOf($, node);
  const withoutName = text.replace(name, ' ');
  return firstTitleLike(withoutName);
}

function firstTitleLike(text: string): string | null {
  for (const segment of text.split(/[|•\n]|\s{2,}|,\s/)) {
    const cleaned = collapseWhitespace(segment);
    if (cleaned.length < 3 || cleaned.length > 90) continue;
    if (cleaned.includes('@')) continue;
    if (classifyHeader(cleaned) !== 'unknown') continue;
    if (looksLikeTitle(cleaned)) return cleaned;
  }
  return null;
}

function guessPhoneWithin(text: string): string | null {
  const match = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.exec(text);
  if (match === null) return null;
  return normalizePhone(match[0]);
}
