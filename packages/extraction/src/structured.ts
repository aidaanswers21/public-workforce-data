import { collapseWhitespace } from '@public-workforce/core';
import type { Html } from './html.js';

export interface StructuredPerson {
  name: string;
  title: string | null;
  email: string | null;
  telephone: string | null;
  department: string | null;
  affiliation: string | null;
  source: 'json_ld' | 'microdata';
}

/**
 * Read Person entries from JSON-LD blocks.
 *
 * Preferred over HTML heuristics wherever a site publishes it: the site itself
 * has told us which string is a name and which is a job title, so there is no
 * guessing to get wrong.
 */
export function extractJsonLdPersons($: Html): StructuredPerson[] {
  const people: StructuredPerson[] = [];
  $('script[type="application/ld+json"]').each((_index, element) => {
    const raw = $(element).contents().text();
    if (raw.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    for (const node of flattenJsonLd(parsed)) {
      const person = toStructuredPerson(node);
      if (person !== null) people.push(person);
    }
  });
  return people;
}

function flattenJsonLd(value: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    out.push(record);
    for (const key of ['@graph', 'itemListElement', 'item', 'member', 'employee']) {
      if (key in record) visit(record[key], depth + 1);
    }
  };
  visit(value, 0);
  return out;
}

function toStructuredPerson(node: Record<string, unknown>): StructuredPerson | null {
  const type = node['@type'];
  const types = (Array.isArray(type) ? type : [type]).filter(
    (value): value is string => typeof value === 'string',
  );
  if (!types.some((value) => value.toLowerCase() === 'person')) return null;

  const name = readString(node['name']) ?? joinNames(node);
  if (name === null || name.length === 0) return null;

  return {
    name,
    title: readString(node['jobTitle']),
    email: normalizeEmailValue(readString(node['email'])),
    telephone: readString(node['telephone']),
    department: readString(node['department']) ?? readNested(node['worksFor'], 'department'),
    affiliation: readNested(node['worksFor'], 'name') ?? readNested(node['affiliation'], 'name'),
    source: 'json_ld',
  };
}

function joinNames(node: Record<string, unknown>): string | null {
  const given = readString(node['givenName']);
  const family = readString(node['familyName']);
  const joined = [given, family].filter((part): part is string => part !== null).join(' ');
  return joined.length > 0 ? joined : null;
}

function readString(value: unknown): string | null {
  if (typeof value === 'string') {
    const cleaned = collapseWhitespace(value);
    return cleaned.length > 0 ? cleaned : null;
  }
  if (Array.isArray(value) && value.length > 0) return readString(value[0]);
  return null;
}

function readNested(value: unknown, key: string): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return readString((value as Record<string, unknown>)[key]);
}

function normalizeEmailValue(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/^mailto:/i, '')
    .trim()
    .toLowerCase();
}

/** Read Person entries marked up with schema.org microdata attributes. */
export function extractMicrodataPersons($: Html): StructuredPerson[] {
  const people: StructuredPerson[] = [];
  $('[itemscope][itemtype*="schema.org/Person" i]').each((_index, element) => {
    const scope = $(element);
    const prop = (name: string): string | null => {
      const node = scope.find(`[itemprop="${name}"]`).first();
      if (node.length === 0) return null;
      const content = node.attr('content');
      const value = content !== undefined ? content : node.text();
      const cleaned = collapseWhitespace(value);
      return cleaned.length > 0 ? cleaned : null;
    };
    const name = prop('name') ?? [prop('givenName'), prop('familyName')].filter(Boolean).join(' ');
    if (name.length === 0) return;
    people.push({
      name,
      title: prop('jobTitle'),
      email: normalizeEmailValue(prop('email')),
      telephone: prop('telephone'),
      department: prop('department'),
      affiliation: prop('worksFor'),
      source: 'microdata',
    });
  });
  return people;
}
