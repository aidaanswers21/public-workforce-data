import type {
  AdapterContext,
  DirectoryAdapter,
  DirectoryVocabulary,
  FetchedPage,
  PaginationKind,
} from '@public-workforce/shared-types';
import type { ExtractedPersonRecord } from '@public-workforce/shared-types';
import { canonicalizeUrl, contentHash, isSyntacticallyValidEmail } from '@public-workforce/core';
import { EXTRACTION_METHODS_BY_CODE, baseTaxonomy } from '@public-workforce/taxonomy';

export interface ExpectedRecord {
  fullNamePublished: string;
  titlePublished?: string | null;
  departmentPublished?: string | null;
  organizationPublished?: string | null;
  phonePublished?: string | null;
  emails?: string[];
  profileUrl?: string | null;
}

export interface AdapterFixture {
  name: string;
  url: string;
  html: string;
  kind: 'listing' | 'profile';
  contentType?: string;
  context?: Partial<AdapterContext>;
  expected?: {
    detectionScoreAtLeast?: number;
    recordCount?: number;
    records?: ExpectedRecord[];
    empty?: boolean;
    paginationKind?: PaginationKind | null;
    paginationTokens?: string[];
    paginationExhausted?: boolean;
  };
}

export interface ContractCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Build a FetchedPage from fixture bytes. No network, no clock dependency. */
export function fixturePage(fixture: AdapterFixture): FetchedPage {
  const url = canonicalizeUrl(fixture.url) ?? fixture.url;
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: { 'content-type': fixture.contentType ?? 'text/html; charset=utf-8' },
    body: fixture.html,
    contentType: fixture.contentType ?? 'text/html',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    contentHash: contentHash(fixture.html),
    fromCache: true,
  };
}

/**
 * The vocabulary a fixture runs against.
 *
 * Defaults to the neutral base, so a contract test proves an adapter works
 * without any sector loaded. A fixture that needs a vertical's words supplies a
 * composed taxonomy through `fixture.context`.
 */
export function fixtureVocabulary(fixture: AdapterFixture): DirectoryVocabulary {
  return fixture.context?.vocabulary ?? baseTaxonomy().vocabulary;
}

export function fixtureContext(fixture: AdapterFixture): AdapterContext {
  const page = fixturePage(fixture);
  return {
    baseUrl: page.finalUrl,
    organizationName: null,
    parentOrganizationName: null,
    allowedDomains: [new URL(page.finalUrl).hostname],
    vocabulary: fixtureVocabulary(fixture),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    ...fixture.context,
  };
}

/**
 * The behavioural half of the adapter contract, which types cannot express.
 *
 * Every adapter must pass all of these against every one of its fixtures. The
 * determinism and record-key checks are the load-bearing ones: idempotent
 * recrawls depend entirely on an adapter producing byte-identical record keys
 * for an unchanged page.
 */
export function checkAdapterContract(
  adapter: DirectoryAdapter,
  fixture: AdapterFixture,
): ContractCheck[] {
  const checks: ContractCheck[] = [];
  const add = (name: string, passed: boolean, detail = ''): void => {
    checks.push({ name, passed, detail });
  };

  add('adapter key is non-empty', adapter.key.trim().length > 0, adapter.key);
  add('adapter version is set', /^\d+\.\d+\.\d+$/.test(adapter.version), adapter.version);
  add(
    'detection threshold is within 0..1',
    adapter.detectionThreshold >= 0 && adapter.detectionThreshold <= 1,
    String(adapter.detectionThreshold),
  );

  const page = fixturePage(fixture);
  const context = fixtureContext(fixture);
  const frozenBody = page.body;

  const detection = adapter.detect({
    url: page.url,
    page,
    hints: {},
    vocabulary: fixtureVocabulary(fixture),
  });
  add(
    'detect returns this adapter key',
    detection.adapterKey === adapter.key,
    detection.adapterKey,
  );
  add(
    'detect score is within 0..1',
    detection.score >= 0 && detection.score <= 1,
    String(detection.score),
  );
  const detectionAgain = adapter.detect({
    url: page.url,
    page,
    hints: {},
    vocabulary: fixtureVocabulary(fixture),
  });
  add(
    'detect is deterministic',
    detectionAgain.score === detection.score,
    `${detection.score} vs ${detectionAgain.score}`,
  );
  if (fixture.expected?.detectionScoreAtLeast !== undefined) {
    add(
      `detect scores at least ${fixture.expected.detectionScoreAtLeast}`,
      detection.score >= fixture.expected.detectionScoreAtLeast,
      String(detection.score),
    );
  }

  if (fixture.kind === 'profile') {
    const profile = adapter.extractProfile(page, context);
    add('extractProfile returns a record or null', profile === null || typeof profile === 'object');
    if (profile !== null) {
      checks.push(...checkRecords([profile], fixture, 'profile'));
      const again = adapter.extractProfile(page, context);
      add(
        'extractProfile record key is deterministic',
        again?.recordKey === profile.recordKey,
        `${profile.recordKey} vs ${again?.recordKey ?? 'null'}`,
      );
    }
    add('adapter did not mutate the page body', page.body === frozenBody);
    return checks;
  }

  const first = adapter.extractListing(page, context);
  const second = adapter.extractListing(page, context);

  add(
    'extractListing is deterministic',
    JSON.stringify(first.records) === JSON.stringify(second.records),
    'two extractions of the same page differ',
  );
  add(
    'empty flag agrees with record count',
    first.empty === (first.records.length === 0),
    `empty=${first.empty} records=${first.records.length}`,
  );
  add('adapter did not mutate the page body', page.body === frozenBody);

  const keys = first.records.map((record) => record.recordKey);
  add(
    'record keys are unique within a page',
    new Set(keys).size === keys.length,
    `${keys.length} records, ${new Set(keys).size} unique keys`,
  );

  checks.push(...checkRecords(first.records, fixture, 'listing'));

  const pagination = adapter.discoverPagination(page, context);
  const tokens = pagination.requests.map((request) => request.token);
  add('pagination tokens are unique', new Set(tokens).size === tokens.length, tokens.join(','));
  add(
    'pagination tokens are non-empty',
    tokens.every((token) => token.trim().length > 0),
    tokens.join(','),
  );
  add(
    'pagination urls are resolvable',
    pagination.requests.every((request) => canonicalizeUrl(request.url, page.finalUrl) !== null),
    pagination.requests.map((request) => request.url).join(' '),
  );
  add(
    'discoverPagination agrees with extractListing',
    JSON.stringify(tokens) ===
      JSON.stringify(first.pagination.requests.map((request) => request.token)),
    'the two pagination entry points returned different plans',
  );

  const expected = fixture.expected;
  if (expected?.recordCount !== undefined) {
    add(
      `extracts ${expected.recordCount} records`,
      first.records.length === expected.recordCount,
      `got ${first.records.length}`,
    );
  }
  if (expected?.empty !== undefined) {
    add(`empty is ${expected.empty}`, first.empty === expected.empty, `got ${first.empty}`);
  }
  if (expected?.paginationKind !== undefined) {
    add(
      `pagination kind is ${expected.paginationKind ?? 'null'}`,
      pagination.kind === expected.paginationKind,
      `got ${pagination.kind ?? 'null'}`,
    );
  }
  if (expected?.paginationTokens !== undefined) {
    add(
      'pagination tokens match expectation',
      JSON.stringify(tokens) === JSON.stringify(expected.paginationTokens),
      `got ${JSON.stringify(tokens)}`,
    );
  }
  if (expected?.paginationExhausted !== undefined) {
    add(
      `pagination exhausted is ${expected.paginationExhausted}`,
      pagination.exhausted === expected.paginationExhausted,
      `got ${pagination.exhausted}`,
    );
  }
  if (expected?.records !== undefined) {
    checks.push(...checkExpectedRecords(first.records, expected.records));
  }

  return checks;
}

function checkRecords(
  records: readonly ExtractedPersonRecord[],
  _fixture: AdapterFixture,
  label: string,
): ContractCheck[] {
  const checks: ContractCheck[] = [];
  const bad = (predicate: (record: ExtractedPersonRecord) => boolean): ExtractedPersonRecord[] =>
    records.filter(predicate);

  const unnamed = bad((record) => record.fullNamePublished.trim().length === 0);
  checks.push({
    name: `${label}: every record has a published name`,
    passed: unnamed.length === 0,
    detail: `${unnamed.length} unnamed records`,
  });

  const badConfidence = bad((record) => record.confidence < 0 || record.confidence > 1);
  checks.push({
    name: `${label}: confidence is within 0..1`,
    passed: badConfidence.length === 0,
    detail: badConfidence
      .map((record) => `${record.fullNamePublished}=${record.confidence}`)
      .join(','),
  });

  const badMethod = bad((record) => !EXTRACTION_METHODS_BY_CODE.has(record.extractionMethod));
  checks.push({
    name: `${label}: extraction method is a known value`,
    passed: badMethod.length === 0,
    detail: badMethod.map((record) => record.extractionMethod).join(','),
  });

  const badEmails = records.flatMap((record) =>
    record.emails.filter(
      (email) =>
        !isSyntacticallyValidEmail(email.address) || email.address !== email.address.toLowerCase(),
    ),
  );
  checks.push({
    name: `${label}: emails are valid and lower-cased`,
    passed: badEmails.length === 0,
    detail: badEmails.map((email) => email.address).join(','),
  });

  const duplicateEmails = records.filter(
    (record) => new Set(record.emails.map((email) => email.address)).size !== record.emails.length,
  );
  checks.push({
    name: `${label}: a record does not repeat an address`,
    passed: duplicateEmails.length === 0,
    detail: duplicateEmails.map((record) => record.fullNamePublished).join(','),
  });

  return checks;
}

function checkExpectedRecords(
  actual: readonly ExtractedPersonRecord[],
  expected: readonly ExpectedRecord[],
): ContractCheck[] {
  return expected.map((want) => {
    const match = actual.find((record) => record.fullNamePublished === want.fullNamePublished);
    if (match === undefined) {
      return {
        name: `record "${want.fullNamePublished}" is extracted`,
        passed: false,
        detail: `not found among ${actual.length} records`,
      };
    }
    const mismatches: string[] = [];
    const compare = (field: keyof ExpectedRecord, got: string | null): void => {
      const wanted = want[field];
      if (wanted === undefined) return;
      if ((wanted ?? null) !== got)
        mismatches.push(`${field}: expected ${String(wanted)}, got ${String(got)}`);
    };
    compare('titlePublished', match.titlePublished);
    compare('departmentPublished', match.departmentPublished);
    compare('organizationPublished', match.organizationPublished);
    compare('phonePublished', match.phonePublished);
    compare('profileUrl', match.profileUrl);
    if (want.emails !== undefined) {
      const got = match.emails.map((email) => email.address).sort();
      const wanted = [...want.emails].sort();
      if (JSON.stringify(got) !== JSON.stringify(wanted)) {
        mismatches.push(`emails: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
      }
    }
    return {
      name: `record "${want.fullNamePublished}" matches expectation`,
      passed: mismatches.length === 0,
      detail: mismatches.join('; '),
    };
  });
}

/** Convenience for tests: the failing checks only. */
export function contractViolations(
  adapter: DirectoryAdapter,
  fixture: AdapterFixture,
): ContractCheck[] {
  return checkAdapterContract(adapter, fixture).filter((check) => !check.passed);
}
