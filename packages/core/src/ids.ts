import { randomUUID } from 'node:crypto';
import type { Uuid } from '@public-workforce/shared-types';
import { shortHash } from './hash.js';

export function newUuid(): Uuid {
  return randomUUID();
}

/**
 * Deterministic record key for one person on one source page.
 *
 * Identical inputs must always produce an identical key: this is what stops a
 * recrawl of an unchanged page from creating duplicate rows. The local key is
 * whatever the adapter can see that identifies the row (a profile link, a staff
 * id, or the published name plus its ordinal position when nothing better exists).
 */
export function deterministicRecordKey(input: {
  adapterKey: string;
  sourceUrl: string;
  localKey: string;
}): string {
  const canonical = [input.adapterKey, input.sourceUrl, input.localKey.trim().toLowerCase()].join(
    ' ',
  );
  return `${input.adapterKey}:${shortHash(canonical, 24)}`;
}

/** Stable identity for a page within a crawl, keyed on the canonical URL. */
export function urlHash(canonicalUrl: string): string {
  return shortHash(canonicalUrl, 32);
}
