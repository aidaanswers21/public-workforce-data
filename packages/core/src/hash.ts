import { createHash } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Short, collision-resistant-enough digest for keys embedded in ids. */
export function shortHash(input: string, length = 16): string {
  return sha256(input).slice(0, length);
}

/**
 * Deterministic JSON: object keys sorted at every level.
 *
 * Used wherever a hash must be stable across processes and Node versions, such
 * as the audit-event hash chain and content-addressed extraction caches.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

export function hashObject(value: unknown): string {
  return sha256(stableStringify(value));
}

/**
 * Content hash used for duplicate-page detection.
 *
 * Whitespace is collapsed and common volatile fragments (CSRF tokens, build
 * hashes, timestamps) are blanked so that two renders of the same directory
 * page hash identically instead of looking like fresh content forever.
 */
export function contentHash(body: string): string {
  const normalized = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/name="(csrf|_token|authenticity_token)"\s+value="[^"]*"/gi, 'name="$1" value=""')
    .replace(/\b[0-9a-f]{32,64}\b/gi, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sha256(normalized);
}
