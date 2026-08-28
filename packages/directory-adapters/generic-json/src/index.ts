import type {
  AdapterContext,
  DetectionContext,
  DetectionResult,
  DirectoryAdapter,
  DiscoveredDirectory,
  ExtractedPersonRecord,
  FetchedPage,
  ListingExtraction,
  PaginationPlan,
  PaginationRequest,
} from '@pan/shared-types';
import { canonicalizeUrl, collapseWhitespace, dedupeExtractedRecords } from '@pan/core';
import { buildPersonRecord, clamp01, looksLikePersonName } from '@pan/adapter-kit';

export const GENERIC_JSON_ADAPTER_KEY = 'generic-json';

/** Keys a JSON directory is likely to use, checked in order of specificity. */
const FIELD_ALIASES = {
  fullName: [
    'full_name',
    'fullName',
    'displayName',
    'display_name',
    'name',
    'staff_name',
    'employee_name',
  ],
  firstName: ['first_name', 'firstName', 'given_name', 'givenName', 'first'],
  lastName: ['last_name', 'lastName', 'family_name', 'familyName', 'last', 'surname'],
  title: ['title', 'job_title', 'jobTitle', 'position', 'role', 'assignment'],
  email: ['email', 'email_address', 'emailAddress', 'mail', 'work_email'],
  phone: ['phone', 'phone_number', 'phoneNumber', 'telephone', 'work_phone'],
  department: ['department', 'dept', 'division', 'team'],
  school: ['school', 'campus', 'building', 'site', 'location', 'school_name'],
  id: ['id', 'staff_id', 'staffId', 'employee_id', 'employeeId', 'uuid', 'guid'],
  profileUrl: ['profile_url', 'profileUrl', 'url', 'link', 'permalink'],
} as const;

/** Where a list of people might live in a JSON envelope. */
const COLLECTION_KEYS = [
  'data',
  'results',
  'items',
  'records',
  'staff',
  'employees',
  'people',
  'rows',
  'directory',
];

/** Cursor-style continuation fields, checked in order. */
const CURSOR_KEYS = [
  'next_cursor',
  'nextCursor',
  'cursor',
  'next_page_token',
  'nextPageToken',
  'after',
];
const NEXT_URL_KEYS = ['next', 'next_url', 'nextUrl', 'next_page_url', 'nextPageUrl'];

/**
 * Adapter for directories backed by a JSON endpoint.
 *
 * Registered alongside the HTML adapter and selected by score, this is the
 * worked example that adding a platform means adding a class and registering
 * it: the crawl engine, normalization pipeline and state configuration are
 * untouched by its existence.
 */
export class GenericJsonAdapter implements DirectoryAdapter {
  readonly key = GENERIC_JSON_ADAPTER_KEY;
  readonly version = '1.0.0';
  readonly displayName = 'Generic JSON directory API';
  readonly detectionThreshold = 0.4;
  readonly requiresBrowser = false;

  detect(context: DetectionContext): DetectionResult {
    const reasons: string[] = [];
    let score = 0;

    if (/\/(api|rest|json|graphql)(\/|$|\?)/i.test(context.url)) {
      score = 0.4;
      reasons.push('url looks like an api endpoint');
    }

    if (context.page !== null) {
      const contentType = context.page.contentType ?? '';
      if (/application\/(json|.*\+json)/i.test(contentType)) {
        score = Math.max(score, 0.6);
        reasons.push('json content type');
      }
      const parsed = safeParse(context.page.body);
      if (parsed === null) {
        if (score > 0) reasons.push('body is not parseable json');
        return { adapterKey: this.key, score: 0, platformKey: null, reasons };
      }
      const collection = findCollection(parsed);
      if (collection !== null && collection.length > 0) {
        const personLike = collection.filter(
          (item) => readField(item, 'fullName') !== null || readField(item, 'lastName') !== null,
        );
        if (personLike.length > 0) {
          score = Math.max(score, 0.9);
          reasons.push(`json collection of ${collection.length} person-shaped objects`);
        }
      }
    }

    if (score === 0) reasons.push('no json directory signals found');
    return { adapterKey: this.key, score: clamp01(score), platformKey: null, reasons };
  }

  discoverDirectories(
    _page: FetchedPage,
    _context: AdapterContext,
  ): readonly DiscoveredDirectory[] {
    // A JSON endpoint is the directory. Discovery is the HTML adapter's job.
    return [];
  }

  extractListing(page: FetchedPage, _context: AdapterContext): ListingExtraction {
    const parsed = safeParse(page.body);
    if (parsed === null) {
      return {
        records: [],
        pagination: { kind: null, requests: [], exhausted: true, note: 'body is not json' },
        context: {},
        empty: true,
        warnings: ['response body was not parseable json'],
      };
    }

    const collection = findCollection(parsed) ?? [];
    const records: ExtractedPersonRecord[] = [];

    collection.forEach((item, index) => {
      const record = this.toRecord(item, index, page.finalUrl);
      if (record !== null) records.push(record);
    });

    const deduped = dedupeExtractedRecords(records);
    return {
      records: deduped,
      pagination: this.paginationFrom(parsed, page.finalUrl),
      context: {},
      empty: deduped.length === 0,
      warnings:
        collection.length > 0 && deduped.length === 0
          ? ['json collection was present but no entries had a usable published name']
          : [],
    };
  }

  private toRecord(item: unknown, index: number, sourceUrl: string): ExtractedPersonRecord | null {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;

    const explicit = readField(record, 'fullName');
    const composed = [readField(record, 'firstName'), readField(record, 'lastName')]
      .filter((part): part is string => part !== null)
      .join(' ');
    const name = explicit ?? (composed.length > 0 ? composed : null);
    if (name === null || !looksLikePersonName(name)) return null;

    const email = readField(record, 'email');
    const localKey = readField(record, 'id') ?? email ?? `${name}#${index}`;

    return buildPersonRecord({
      adapterKey: this.key,
      sourceUrl,
      localKey,
      fullNamePublished: name,
      titlePublished: readField(record, 'title'),
      departmentPublished: readField(record, 'department'),
      schoolPublished: readField(record, 'school'),
      phonePublished: readField(record, 'phone'),
      profileUrl: readField(record, 'profileUrl'),
      emailSources: email === null ? [] : [email],
      extractionMethod: 'json_api',
      confidence: 0.92,
      selector: `$.[${index}]`,
      snippet: JSON.stringify(record).slice(0, 300),
    });
  }

  extractProfile(page: FetchedPage, _context: AdapterContext): ExtractedPersonRecord | null {
    const parsed = safeParse(page.body);
    if (parsed === null) return null;
    const single = findCollection(parsed)?.[0] ?? parsed;
    return this.toRecord(single, 0, page.finalUrl);
  }

  discoverPagination(page: FetchedPage, _context: AdapterContext): PaginationPlan {
    const parsed = safeParse(page.body);
    if (parsed === null)
      return { kind: null, requests: [], exhausted: true, note: 'body is not json' };
    return this.paginationFrom(parsed, page.finalUrl);
  }

  /**
   * Cursor first, then an explicit next url, then offset arithmetic.
   *
   * Only one continuation is ever emitted: mixing a cursor with a guessed offset
   * is how an API crawl ends up walking the same records twice.
   */
  private paginationFrom(parsed: unknown, baseUrl: string): PaginationPlan {
    if (parsed === null || typeof parsed !== 'object') {
      return { kind: null, requests: [], exhausted: true, note: null };
    }
    const envelope = parsed as Record<string, unknown>;
    const meta = (envelope['meta'] ??
      envelope['pagination'] ??
      envelope['page_info'] ??
      envelope) as Record<string, unknown>;

    for (const key of CURSOR_KEYS) {
      const cursor = meta[key] ?? envelope[key];
      if (typeof cursor !== 'string' || cursor.length === 0) continue;
      const url = withParam(baseUrl, 'cursor', cursor);
      if (url === null) continue;
      return {
        kind: 'cursor_api',
        requests: [{ url, kind: 'cursor_api', token: `cursor:${cursor}` }],
        exhausted: false,
        note: `cursor field "${key}"`,
      };
    }

    for (const key of NEXT_URL_KEYS) {
      const next = meta[key] ?? envelope[key];
      if (typeof next !== 'string' || next.length === 0) continue;
      const url = canonicalizeUrl(next, baseUrl);
      if (url === null) continue;
      return {
        kind: 'cursor_api',
        requests: [{ url, kind: 'cursor_api', token: `next:${url}` }],
        exhausted: false,
        note: `next-url field "${key}"`,
      };
    }

    const offset = readNumber(meta, ['offset', 'start']);
    const limit = readNumber(meta, ['limit', 'per_page', 'perPage', 'page_size', 'pageSize']);
    const total = readNumber(meta, ['total', 'total_count', 'totalCount', 'count']);
    if (offset !== null && limit !== null && limit > 0) {
      const nextOffset = offset + limit;
      if (total === null || nextOffset < total) {
        const url = withParam(
          withParam(baseUrl, 'offset', String(nextOffset)) ?? baseUrl,
          'limit',
          String(limit),
        );
        if (url !== null) {
          const request: PaginationRequest = {
            url,
            kind: 'offset_param',
            token: `offset:${nextOffset}`,
          };
          return {
            kind: 'offset_param',
            requests: [request],
            exhausted: false,
            note: 'offset and limit fields',
          };
        }
      }
      return { kind: 'offset_param', requests: [], exhausted: true, note: 'offset reached total' };
    }

    const page = readNumber(meta, ['page', 'current_page', 'currentPage']);
    const totalPages = readNumber(meta, ['total_pages', 'totalPages', 'last_page', 'pages']);
    if (page !== null && totalPages !== null && page < totalPages) {
      const url = withParam(baseUrl, 'page', String(page + 1));
      if (url !== null) {
        return {
          kind: 'page_param',
          requests: [{ url, kind: 'page_param', token: `page:${page + 1}` }],
          exhausted: false,
          note: 'page and total_pages fields',
        };
      }
    }

    return { kind: null, requests: [], exhausted: true, note: 'no continuation fields found' };
  }
}

function safeParse(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Locate the array of people inside whatever envelope the API uses.
 *
 * Known collection keys are preferred, then any other nested object is searched
 * to a bounded depth, because envelopes like `{ response: { items: [...] } }`
 * are common and the wrapper key is rarely one we can predict.
 */
function findCollection(parsed: unknown, depth = 0): Record<string, unknown>[] | null {
  if (depth > 4) return null;
  if (Array.isArray(parsed)) return parsed.filter(isObject);
  if (!isObject(parsed)) return null;
  const envelope = parsed;

  for (const key of COLLECTION_KEYS) {
    const value = envelope[key];
    if (Array.isArray(value)) return value.filter(isObject);
  }
  for (const key of COLLECTION_KEYS) {
    const value = envelope[key];
    if (!isObject(value)) continue;
    const nested = findCollection(value, depth + 1);
    if (nested !== null && nested.length > 0) return nested;
  }
  for (const value of Object.values(envelope)) {
    if (!isObject(value) && !Array.isArray(value)) continue;
    const nested = findCollection(value, depth + 1);
    if (nested !== null && nested.length > 0) return nested;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readField(
  record: Record<string, unknown>,
  field: keyof typeof FIELD_ALIASES,
): string | null {
  for (const alias of FIELD_ALIASES[field]) {
    const value = record[alias];
    if (typeof value === 'string') {
      const cleaned = collapseWhitespace(value);
      if (cleaned.length > 0) return cleaned;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function withParam(baseUrl: string, key: string, value: string): string | null {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set(key, value);
    return canonicalizeUrl(url.toString());
  } catch {
    return null;
  }
}

export const genericJsonAdapter = new GenericJsonAdapter();
