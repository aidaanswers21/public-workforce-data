import { describe, expect, it } from 'vitest';
import {
  checkAdapterContract,
  fixtureContext,
  fixturePage,
  type AdapterFixture,
} from '@pan/adapter-kit';
import { allSectorsTaxonomy } from '../../../../tests/support/taxonomy.js';
import { loadAdapterFixture } from '../../../../tests/support/fixtures.js';
import { genericHtmlAdapter } from './index.js';

const TAXONOMY = allSectorsTaxonomy();
const VOCABULARY = TAXONOMY.vocabulary;

/** Every fixture runs against the composed vocabulary the worker would use. */
function withVocabulary(fixture: AdapterFixture): AdapterFixture {
  return { ...fixture, context: { ...fixture.context, vocabulary: VOCABULARY } };
}

const FIXTURES: AdapterFixture[] = [
  loadAdapterFixture({
    name: 'table with numbered pagination',
    file: 'generic-html/table-numbered/page-1.html',
    url: 'https://sample-isd.example.org/staff-directory?page=1',
    expected: {
      detectionScoreAtLeast: 0.7,
      recordCount: 3,
      empty: false,
      paginationKind: 'numbered',
      records: [
        {
          fullNamePublished: 'Rivera, Ana M.',
          titlePublished: 'Principal',
          departmentPublished: 'Administration',
          phonePublished: '555-010-1001',
          emails: ['ana.rivera@sample-isd.example.org'],
        },
        {
          fullNamePublished: "O'Brien, Katherine",
          titlePublished: 'School Counselor',
          emails: ['katherine.obrien@sample-isd.example.org'],
        },
      ],
    },
  }),
  loadAdapterFixture({
    name: 'cards with rel=next',
    file: 'generic-html/cards-next-link/page-1.html',
    url: 'https://sample-isd.example.org/faculty',
    expected: {
      recordCount: 4,
      paginationKind: 'next_link',
      paginationTokens: ['next_link:https://sample-isd.example.org/faculty?page=2'],
      records: [
        { fullNamePublished: 'Dr. Priya Raman', titlePublished: 'Assistant Superintendent' },
      ],
    },
  }),
  loadAdapterFixture({
    name: 'obfuscated addresses',
    file: 'generic-html/obfuscated/index.html',
    url: 'https://sample-isd.example.org/staff-directory',
    expected: {
      recordCount: 5,
      records: [
        { fullNamePublished: 'Helen Ashcroft', emails: ['helen.ashcroft@sample-isd.example.org'] },
        { fullNamePublished: 'Samuel Ortiz', emails: ['samuel.ortiz@sample-isd.example.org'] },
        { fullNamePublished: 'Nadia Haddad', emails: ['nadia.haddad@sample-isd.example.org'] },
        { fullNamePublished: 'Hidden Person', emails: ['hidden.person@sample-isd.example.org'] },
        {
          fullNamePublished: 'Grace Lindqvist',
          emails: ['grace.lindqvist@sample-isd.example.org'],
        },
      ],
    },
  }),
  loadAdapterFixture({
    name: 'json-ld administration listing',
    file: 'generic-html/jsonld/index.html',
    url: 'https://sample-isd.example.org/administration',
    expected: {
      recordCount: 3,
      records: [
        {
          fullNamePublished: 'Eleanor Vance',
          titlePublished: 'Superintendent',
          emails: ['eleanor.vance@sample-isd.example.org'],
        },
        { fullNamePublished: 'Hector Ramos', titlePublished: 'Chief Financial Officer' },
      ],
    },
  }),
  loadAdapterFixture({
    name: 'empty directory',
    file: 'generic-html/empty-directory/index.html',
    url: 'https://sample-isd.example.org/staff-directory',
    expected: { recordCount: 0, empty: true, paginationKind: null, paginationExhausted: true },
  }),
  loadAdapterFixture({
    name: 'alphabetical filter index',
    file: 'generic-html/alpha-filter/index.html',
    url: 'https://sample-isd.example.org/staff',
    expected: { recordCount: 3, paginationKind: 'alpha_filter' },
  }),
  loadAdapterFixture({
    name: 'staff profile page',
    file: 'generic-html/profile/priya-raman.html',
    url: 'https://sample-isd.example.org/staff/priya-raman',
    kind: 'profile',
  }),
].map(withVocabulary);

describe.each(FIXTURES)('generic-html adapter contract: $name', (fixture) => {
  const checks = checkAdapterContract(genericHtmlAdapter, fixture);

  it('runs at least one check', () => {
    expect(checks.length).toBeGreaterThan(0);
  });

  it.each(checks)('$name', (check) => {
    expect(check.passed, `${check.name}: ${check.detail}`).toBe(true);
  });
});

describe('generic-html adapter behaviour', () => {
  it('extracts the profile page fields from microdata', () => {
    const fixture = FIXTURES.find((f) => f.kind === 'profile')!;
    const record = genericHtmlAdapter.extractProfile(fixturePage(fixture), fixtureContext(fixture));
    expect(record?.fullNamePublished).toBe('Dr. Priya Raman');
    expect(record?.titlePublished).toBe('Assistant Superintendent');
    expect(record?.emails[0]?.address).toBe('priya.raman@sample-isd.example.org');
    expect(record?.extractionMethod).toBe('microdata');
  });

  it('flags a shared office inbox rather than treating it as a person address', () => {
    const fixture = withVocabulary(
      loadAdapterFixture({
        name: 'page 3',
        file: 'generic-html/table-numbered/page-3.html',
        url: 'https://sample-isd.example.org/staff-directory?page=3',
      }),
    );
    const listing = genericHtmlAdapter.extractListing(
      fixturePage(fixture),
      fixtureContext(fixture),
    );
    const office = listing.records.find((record) =>
      record.emails.some((e) => e.address.startsWith('office@')),
    );
    expect(office?.emails[0]?.looksLikeGeneralInbox).toBe(true);
  });

  it('ranks real directory links above calendar and news traps during discovery', () => {
    const fixture = withVocabulary(
      loadAdapterFixture({
        name: 'discovery',
        file: 'generic-html/discovery/index.html',
        url: 'https://sample-isd.example.org/',
      }),
    );
    const found = genericHtmlAdapter.discoverDirectories(
      fixturePage(fixture),
      fixtureContext(fixture),
    );
    const urls = found.map((entry) => entry.url);
    expect(urls[0]).toContain('/staff-directory');
    expect(urls.some((url) => url.includes('/calendar/'))).toBe(false);
    expect(urls.some((url) => url.includes('/news/'))).toBe(false);
    expect(urls.some((url) => url.endsWith('.pdf'))).toBe(false);
  });

  it('scores a page with no directory signals below its own threshold', () => {
    const page = fixturePage({
      name: 'blank',
      url: 'https://sample-isd.example.org/about',
      html: '<html><body><h1>About Us</h1><p>Welcome.</p></body></html>',
      kind: 'listing',
    });
    const detection = genericHtmlAdapter.detect({
      url: page.url,
      page,
      hints: {},
      vocabulary: VOCABULARY,
    });
    expect(detection.score).toBeLessThan(genericHtmlAdapter.detectionThreshold);
  });
});
