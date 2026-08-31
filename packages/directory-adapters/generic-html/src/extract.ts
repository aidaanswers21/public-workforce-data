import type { DirectoryVocabulary, ExtractedPersonRecord } from '@public-workforce/shared-types';
import { collapseWhitespace, normalizePhone } from '@public-workforce/core';
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
} from '@public-workforce/extraction';
import { extractJsonLdPersons, extractMicrodataPersons } from '@public-workforce/extraction';
import { buildPersonRecord, looksLikePersonName } from '@public-workforce/adapter-kit';

export interface ExtractInput {
  $: Html;
  sourceUrl: string;
  adapterKey: string;
  /** Composed from the registered sectors; never hard-coded in this package. */
  vocabulary: DirectoryVocabulary;
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
      organizationPublished: person.affiliation,
      phonePublished: person.telephone,
      emailSources: person.email === null ? [] : [person.email],
      vocabulary: input.vocabulary,
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
    const parsed = parseTable(input.$, table, input.vocabulary.organizationFieldAliases);
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
        organizationPublished: first('organization'),
        phonePublished: first('phone'),
        emailSources,
        cloudflareEncoded: collectCfEmails(input.$, rowHtml),
        profileUrl: firstProfileHref(input.$, rowHtml),
        vocabulary: input.vocabulary,
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

/** Structural selectors that carry no vertical-specific vocabulary. */
const STRUCTURAL_CARD_SELECTORS = [
  '[class*="person" i]',
  '[class*="profile" i]',
  '[class*="member" i]',
  'li',
  'article',
];

/**
 * Class-name selectors built from the composed vocabulary.
 *
 * A site that classes its rows `.personnel-card` and one that uses
 * `.staff-listing` are both found, without this package knowing which vertical
 * contributed either word.
 */
function cardSelectors(vocabulary: DirectoryVocabulary): string[] {
  const fromVocabulary = vocabulary.headingTerms
    .map((term) => term.trim().split(/\s+/)[0] ?? '')
    .filter((word) => /^[a-z]{4,}$/i.test(word))
    .map((word) => `[class*="${word.toLowerCase()}" i]`);
  return [...new Set([...fromVocabulary, ...STRUCTURAL_CARD_SELECTORS])];
}

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

  for (const selector of cardSelectors(input.vocabulary)) {
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

      const name = guessNameWithin($, node, input.vocabulary);
      if (name === null) return;
      const title = guessTitleWithin($, node, name, input.vocabulary);
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
        vocabulary: input.vocabulary,
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
        titlePublished: firstTitleLike(text, input.vocabulary),
        phonePublished: guessPhoneWithin(text),
        emailSources: [...collectHrefEmails($, html), text],
        cloudflareEncoded: collectCfEmails($, html),
        vocabulary: input.vocabulary,
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
      : (guessNameWithin($, container.length > 0 ? container : $(element), input.vocabulary) ??
        null);
    if (name === null) return;

    const record = buildPersonRecord({
      adapterKey: input.adapterKey,
      sourceUrl: input.sourceUrl,
      localKey: `mailto:${href}#${index}`,
      fullNamePublished: name,
      titlePublished: firstTitleLike(containerText, input.vocabulary),
      phonePublished: guessPhoneWithin(containerText),
      emailSources: [href],
      vocabulary: input.vocabulary,
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
    if (!/(staff|profile|bio|person|employee|directory|user|detail)/i.test(href)) return;
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

function guessNameWithin(
  $: Html,
  node: ReturnType<Html>,
  vocabulary: DirectoryVocabulary,
): string | null {
  for (const selector of NAME_SELECTORS) {
    const candidate = node.find(selector).first();
    if (candidate.length === 0) continue;
    const text = textOf($, candidate);
    if (looksLikePersonName(text) && !looksLikeTitleText(text, vocabulary)) return text;
  }
  const own = textOf($, node);
  const firstLine = own.split(/[|,•]/)[0] ?? '';
  return looksLikePersonName(firstLine) && !looksLikeTitleText(firstLine, vocabulary)
    ? collapseWhitespace(firstLine)
    : null;
}

function guessTitleWithin(
  $: Html,
  node: ReturnType<Html>,
  name: string,
  vocabulary: DirectoryVocabulary,
): string | null {
  const explicit = node
    .find('[class*="title" i], [class*="position" i], [class*="role" i], [class*="job" i]')
    .first();
  if (explicit.length > 0) {
    const text = textOf($, explicit);
    if (text.length > 0 && text !== name) return text;
  }
  const text = textOf($, node);
  const withoutName = text.replace(name, ' ');
  return firstTitleLike(withoutName, vocabulary);
}

function firstTitleLike(text: string, vocabulary: DirectoryVocabulary): string | null {
  for (const segment of text.split(/[|•\n]|\s{2,}|,\s/)) {
    const cleaned = collapseWhitespace(segment);
    if (cleaned.length < 3 || cleaned.length > 90) continue;
    if (cleaned.includes('@')) continue;
    if (classifyHeader(cleaned) !== 'unknown') continue;
    if (looksLikeTitleText(cleaned, vocabulary)) return cleaned;
  }
  return null;
}

/**
 * True when a string reads as a job title rather than a name.
 *
 * Uses the composed indicator terms, so a page that says "Bureau Chief" and one
 * that says "Lead Teacher" are both recognized without this package knowing
 * which vertical contributed either word.
 */
function looksLikeTitleText(value: string, vocabulary: DirectoryVocabulary): boolean {
  const cleaned = collapseWhitespace(value).toLowerCase();
  if (cleaned.length === 0) return false;
  if (
    /^(name|staff|employee|title|position|email|phone|department|office|organization)$/.test(
      cleaned,
    )
  ) {
    return true;
  }
  const words = new Set(cleaned.split(/[^a-z]+/).filter(Boolean));
  return vocabulary.titleIndicatorTerms.some((term) => words.has(term.toLowerCase()));
}

function guessPhoneWithin(text: string): string | null {
  const match = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.exec(text);
  if (match === null) return null;
  return normalizePhone(match[0]);
}
