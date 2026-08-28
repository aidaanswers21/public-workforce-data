import type { ObfuscationKind } from '@pan/shared-types';

export interface DecodedEmail {
  /** Text exactly as it appeared on the page. */
  raw: string;
  /** Lower-cased, decoded address. */
  address: string;
  obfuscation: ObfuscationKind;
}

const PLAIN_EMAIL =
  /[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/gi;

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['commat', '@'],
  ['period', '.'],
  ['#64', '@'],
  ['#46', '.'],
]);

/** Decode numeric and the handful of named HTML entities that appear in addresses. */
export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(
      /&([a-z]+);/gi,
      (match, name: string) => NAMED_ENTITIES.get(name.toLowerCase()) ?? match,
    );
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Decode Cloudflare's `data-cfemail` obfuscation.
 *
 * The address is XOR-encoded with the first byte as the key. Any browser
 * renders it in plain text, so this is decoding public display, not defeating
 * an access control.
 */
export function decodeCloudflareEmail(encoded: string): string | null {
  const hex = encoded.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) return null;
    out += String.fromCharCode(byte ^ key);
  }
  return PLAIN_EMAIL.test(out) ? ((PLAIN_EMAIL.lastIndex = 0), out.toLowerCase()) : null;
}

const AT_WORDS = String.raw`\s*(?:\[|\(|\{)?\s*(?:@|at|AT)\s*(?:\]|\)|\})?\s*`;
const DOT_WORDS = String.raw`\s*(?:\[|\(|\{)?\s*(?:\.|dot|DOT|d0t)\s*(?:\]|\)|\})?\s*`;
/** A local-part or domain label: no dots, since dots may be spelled out between segments. */
const SEGMENT = String.raw`[a-z0-9_%+-]+`;
const DOMAIN_SEGMENT = String.raw`[a-z0-9-]+`;
const SPELLED_OUT = new RegExp(
  String.raw`(${SEGMENT}(?:${DOT_WORDS}${SEGMENT})*)${AT_WORDS}(${DOMAIN_SEGMENT}(?:${DOT_WORDS}${DOMAIN_SEGMENT})+)`,
  'gi',
);
const DOT_WORDS_GLOBAL = new RegExp(DOT_WORDS, 'gi');

/** Turn "jane dot smith" or "jane [dot] smith" into "jane.smith". */
function collapseSpelledDots(value: string): string {
  return value
    .replace(DOT_WORDS_GLOBAL, '.')
    .replace(/\s+/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '');
}

/**
 * Recover addresses written as "jane dot smith at example dot org" or
 * "jane[at]example.org". These are publicly displayed for humans to read.
 */
export function decodeSpelledOut(input: string): DecodedEmail[] {
  const found: DecodedEmail[] = [];
  for (const match of input.matchAll(SPELLED_OUT)) {
    const raw = match[0];
    const local = collapseSpelledDots(match[1] ?? '');
    const domainPart = collapseSpelledDots(match[2] ?? '');
    const address = `${local}@${domainPart}`.toLowerCase();
    if (!isSyntacticallyValidEmail(address)) continue;
    // Bracketed forms are reported as such even though "[at]" also contains
    // the word "at": the stored kind should describe what the page actually did.
    const bracketed = /[[({]\s*(?:at|dot|@|\.)\s*[\])}]/i.test(raw);
    const spelled = /\b(at|dot|d0t)\b/i.test(raw);
    found.push({
      raw: raw.trim(),
      address,
      obfuscation: bracketed ? 'bracketed_at' : spelled ? 'at_dot_words' : 'none',
    });
  }
  return found;
}

/** Basic RFC-shaped syntax check. Deliberately strict about the obvious failures only. */
export function isSyntacticallyValidEmail(address: string): boolean {
  if (address.length === 0 || address.length > 254) return false;
  const parts = address.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || local.length > 64 || domain.length === 0) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local)) return false;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) return false;
  if (domain.includes('..') || domain.startsWith('-')) return false;
  return true;
}

/**
 * Find every address in a blob of text or HTML, decoding basic obfuscation.
 *
 * Order matters: entities are decoded first so that `&#106;ane@x.org` is found
 * by the plain matcher, then the spelled-out forms are recovered from whatever
 * the plain matcher did not already claim.
 */
export function extractEmailsFromText(input: string): DecodedEmail[] {
  const results = new Map<string, DecodedEmail>();

  const decodedEntities = decodeHtmlEntities(input);
  const hadEntities = decodedEntities !== input;

  PLAIN_EMAIL.lastIndex = 0;
  for (const match of decodedEntities.matchAll(PLAIN_EMAIL)) {
    const address = match[0].toLowerCase().replace(/[.,;:]+$/, '');
    if (!isSyntacticallyValidEmail(address)) continue;
    results.set(address, {
      raw: match[0],
      address,
      obfuscation: hadEntities && !input.includes(match[0]) ? 'html_entity' : 'none',
    });
  }

  for (const decoded of decodeSpelledOut(decodedEntities)) {
    if (!results.has(decoded.address)) results.set(decoded.address, decoded);
  }

  return [...results.values()];
}

/** Pull `mailto:` targets out of an href, decoding percent-encoding. */
export function parseMailtoHref(href: string): DecodedEmail | null {
  if (!/^mailto:/i.test(href.trim())) return null;
  const withoutScheme = href.trim().slice(7).split('?')[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutScheme);
  } catch {
    decoded = withoutScheme;
  }
  const address = decodeHtmlEntities(decoded).trim().toLowerCase();
  if (!isSyntacticallyValidEmail(address)) return null;
  return {
    raw: href.trim(),
    address,
    obfuscation: decoded !== withoutScheme ? 'html_entity' : 'none',
  };
}
