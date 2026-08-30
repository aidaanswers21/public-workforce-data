import { describe, expect, it } from 'vitest';
import {
  checkAdapterContract,
  fixtureContext,
  fixturePage,
  type AdapterFixture,
} from '@pan/adapter-kit';
import { allSectorsTaxonomy } from '../../../../tests/support/taxonomy.js';
import { loadAdapterFixture } from '../../../../tests/support/fixtures.js';
import { genericJsonAdapter } from './index.js';

const TAXONOMY = allSectorsTaxonomy();
const VOCABULARY = TAXONOMY.vocabulary;

function withVocabulary(fixture: AdapterFixture): AdapterFixture {
  return { ...fixture, context: { ...fixture.context, vocabulary: VOCABULARY } };
}

const FIXTURES: AdapterFixture[] = [
  loadAdapterFixture({
    name: 'cursor paginated api',
    file: 'generic-json/cursor-api/page-1.json',
    url: 'https://sample-isd.example.org/api/staff',
    contentType: 'application/json',
    expected: {
      detectionScoreAtLeast: 0.9,
      recordCount: 3,
      paginationKind: 'cursor_api',
      paginationTokens: ['cursor:eyJwYWdlIjoyfQ'],
      records: [
        {
          fullNamePublished: 'Sofia Marchetti',
          titlePublished: 'Special Education Diagnostician',
          organizationPublished: 'Sample High School',
          phonePublished: '555-010-4001',
          emails: ['sofia.marchetti@sample-isd.example.org'],
        },
        { fullNamePublished: 'Winnie Ochieng', titlePublished: 'Library Media Specialist' },
      ],
    },
  }),
  loadAdapterFixture({
    name: 'offset paginated api at the end of the collection',
    file: 'generic-json/offset-api/page-1.json',
    url: 'https://sample-isd.example.org/api/v1/employees',
    contentType: 'application/json',
    expected: {
      recordCount: 2,
      paginationKind: 'offset_param',
      paginationExhausted: true,
      records: [{ fullNamePublished: 'Colin Mbatha', departmentPublished: 'Technology' }],
    },
  }),
].map(withVocabulary);

describe.each(FIXTURES)('generic-json adapter contract: $name', (fixture) => {
  const checks = checkAdapterContract(genericJsonAdapter, fixture);

  it.each(checks)('$name', (check) => {
    expect(check.passed, `${check.name}: ${check.detail}`).toBe(true);
  });
});

describe('generic-json adapter behaviour', () => {
  it('scores html at zero rather than claiming a page it cannot parse', () => {
    const page = fixturePage({
      name: 'html',
      url: 'https://sample-isd.example.org/api/staff',
      html: '<html><body>not json</body></html>',
      kind: 'listing',
    });
    expect(
      genericJsonAdapter.detect({ url: page.url, page, hints: {}, vocabulary: VOCABULARY }).score,
    ).toBe(0);
  });

  it('reports a parse failure as a warning rather than throwing', () => {
    const fixture: AdapterFixture = {
      name: 'broken',
      url: 'https://sample-isd.example.org/api/staff',
      html: '{ "data": [ broken',
      kind: 'listing',
      contentType: 'application/json',
    };
    const listing = genericJsonAdapter.extractListing(
      fixturePage(fixture),
      fixtureContext(fixture),
    );
    expect(listing.empty).toBe(true);
    expect(listing.warnings.length).toBeGreaterThan(0);
  });

  it('reads a collection nested under an envelope key', () => {
    const fixture: AdapterFixture = {
      name: 'nested',
      url: 'https://sample-isd.example.org/api/staff',
      html: JSON.stringify({
        response: {
          items: [
            {
              full_name: 'Ada Byron',
              title: 'Math Teacher',
              email: 'ada.byron@sample-isd.example.org',
            },
          ],
        },
      }),
      kind: 'listing',
      contentType: 'application/json',
    };
    const listing = genericJsonAdapter.extractListing(
      fixturePage(fixture),
      fixtureContext(fixture),
    );
    expect(listing.records[0]?.fullNamePublished).toBe('Ada Byron');
  });
});
