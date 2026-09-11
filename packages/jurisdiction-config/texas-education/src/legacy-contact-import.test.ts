import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  TexasEducationOrganizationIndex,
  legacyArtifactContentType,
  prepareLegacyContact,
  streamLegacyContactLines,
  texasEducationNameKey,
  validateLegacyContactManifest,
} from './legacy-contact-import.js';

const index = new TexasEducationOrganizationIndex([
  {
    organizationId: 'school-1',
    districtName: 'Killeen Independent School District',
    schoolName: 'Alice W Douse Elementary School',
  },
]);

const row = {
  state: 'Texas',
  district: 'Killeen Isd',
  school: 'Alice W Douse El',
  full_name: 'Abigail Gracia-Cruz',
  title: 'Teacher Associate Kindergarten',
  department: '',
  email: 'abigail.graciacruz@killeenisd.org',
  email_source: 'Published mailto on human-viewable staff page',
  directory_url: 'https://www.killeenisd.org/o/dousees/staff?page_no=2',
  collected_at_utc: '2026-09-11T01:23:12.758Z',
};

describe('Texas legacy accepted-contact import', () => {
  it('maps declared Texas abbreviations without fuzzy matching', () => {
    expect(texasEducationNameKey('Killeen Isd', 'district')).toBe(
      texasEducationNameKey('Killeen Independent School District', 'district'),
    );
    expect(texasEducationNameKey('Alice W Douse El', 'school')).toBe(
      texasEducationNameKey('Alice W Douse Elementary School', 'school'),
    );
    expect(index.exactMatch('Killeen Isd', 'Alice W Douse El')).toHaveLength(1);
    expect(index.exactMatch('Killeen Isd', 'Alice W Douse Middle')).toEqual([]);
  });

  it('accepts only a named public work address with an exact organization pair', () => {
    const result = prepareLegacyContact(row, index, 'batch-2', 17);
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') {
      expect(result.record.organizationId).toBe('school-1');
      expect(result.record.emailPublished).toBe('abigail.graciacruz@killeenisd.org');
      expect(result.record.recordKey).toMatch(/^legacy:[a-f0-9]{64}$/);
    }
  });

  it('prefers the human directory URL and rejects API-only provenance', () => {
    const preferred = prepareLegacyContact(
      { ...row, data_source_url: 'https://www.killeenisd.org/api/staff.json' },
      index,
      'batch-2',
      17,
    );
    expect(preferred.status).toBe('accepted');
    if (preferred.status === 'accepted')
      expect(preferred.record.sourcePageUrl).toBe(row.directory_url);

    const apiOnly = prepareLegacyContact(
      { ...row, directory_url: '', data_source_url: 'https://www.killeenisd.org/api/staff.json' },
      index,
      'batch-2',
      17,
    );
    expect(apiOnly).toEqual({
      status: 'quarantined',
      reason: 'source page URL is an API or data endpoint, not a human-viewable page',
    });
  });

  it('preserves Cloudflare decoding as decoded published evidence', () => {
    const result = prepareLegacyContact(
      { ...row, email_source: 'Decoded from Cloudflare cfemail on human staff page' },
      index,
      'batch-2',
      17,
    );
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') {
      expect(result.record.emailClassification).toBe('decoded_published');
      expect(result.record.emailObfuscation).toBe('cloudflare_cfemail');
    }
  });

  it.each([
    [{ ...row, email: 'teacher@gmail.com' }, 'personal'],
    [{ ...row, email_source: 'inferred from district pattern' }, 'inferred'],
    [{ ...row, email_source: 'copied from old CRM' }, 'positive published'],
    [{ ...row, school: 'Unknown School' }, 'no exact'],
    [{ ...row, full_name: 'School Office' }, 'organization label'],
    [{ ...row, directory_url: 'file:///tmp/page.html' }, 'http or https'],
  ])('quarantines unsafe or ambiguous legacy evidence', (input, reason) => {
    const result = prepareLegacyContact(input, index, 'batch-2', 17);
    expect(result.status).toBe('quarantined');
    if (result.status === 'quarantined') expect(result.reason).toContain(reason);
  });

  it('rejects an ambiguous exact organization pair', () => {
    const ambiguous = new TexasEducationOrganizationIndex([
      ...index.exactMatch('Killeen Isd', 'Alice W Douse El'),
      {
        organizationId: 'school-2',
        districtName: 'Killeen ISD',
        schoolName: 'Alice W Douse Elementary',
      },
    ]);
    const result = prepareLegacyContact(row, ambiguous, 'batch-2', 17);
    expect(result).toEqual({
      status: 'quarantined',
      reason: 'Texas district and school match is ambiguous',
    });
  });

  it('uses a published work domain to disambiguate same-named Texas districts', () => {
    const wylie = new TexasEducationOrganizationIndex([
      {
        organizationId: 'wylie-collin-high',
        districtName: 'Wylie ISD',
        schoolName: 'Wylie H S',
        primaryDomains: ['wylieisd.net'],
      },
      {
        organizationId: 'wylie-taylor-high',
        districtName: 'Wylie ISD',
        schoolName: 'Wylie H S',
        primaryDomains: ['wyliebulldogs.org'],
      },
    ]);
    const result = prepareLegacyContact(
      {
        ...row,
        district: 'Wylie Isd',
        school: 'Wylie H S',
        email: 'adam.cherry@wyliebulldogs.org',
        directory_url: 'https://www.wyliebulldogs.org/o/whs/staff?page_no=2',
      },
      wylie,
      'batch-2',
      95_857,
    );
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted')
      expect(result.record.organizationId).toBe('wylie-taylor-high');
  });

  it('requires a checksummed Texas manifest', () => {
    expect(
      validateLegacyContactManifest({
        schemaVersion: 1,
        artifactId: 'batch-2',
        createdAt: '2026-09-11T12:00:00Z',
        contentCutoffAt: '2026-09-11T11:00:00Z',
        jurisdiction: 'texas-education',
        workbookSha256: 'c'.repeat(64),
        approvedDomainAllowlistPath: 'approved_domains.txt',
        approvedDomainAllowlistSha256: 'd'.repeat(64),
        files: [{ path: 'accepted.ndjson', sha256: 'a'.repeat(64) }],
      }),
    ).toMatchObject({ artifactId: 'batch-2' });
    expect(() =>
      validateLegacyContactManifest({
        schemaVersion: 1,
        artifactId: 'batch-2',
        createdAt: '2026-09-11T12:00:00Z',
        contentCutoffAt: '2026-09-11T11:00:00Z',
        jurisdiction: 'texas-education',
        workbookSha256: 'c'.repeat(64),
        approvedDomainAllowlistPath: 'approved_domains.txt',
        approvedDomainAllowlistSha256: 'd'.repeat(64),
        files: [{ path: 'accepted.ndjson', sha256: 'not-a-hash' }],
      }),
    ).toThrow('invalid sha256');
  });

  it('streams gzip-compressed JSONL with stable source line numbers', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'legacy-contact-import-'));
    const path = join(directory, 'accepted.jsonl.gz');
    try {
      await fs.writeFile(path, gzipSync('{"id":1}\n\n{"id":2}\n'));
      const lines = [];
      for await (const value of streamLegacyContactLines(path)) lines.push(value);
      expect(lines).toEqual([
        { lineNumber: 1, line: '{"id":1}' },
        { lineNumber: 2, line: '' },
        { lineNumber: 3, line: '{"id":2}' },
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('records truthful content types for plain and compressed artifacts', () => {
    expect(legacyArtifactContentType('accepted.jsonl.gz')).toBe('application/gzip');
    expect(legacyArtifactContentType('accepted.jsonl')).toBe('application/x-ndjson');
  });

  it('accepts either private storage or an immutable GitHub blob as archive evidence', () => {
    const base = {
      schemaVersion: 1,
      artifactId: 'batch-2',
      createdAt: '2026-09-11T12:00:00Z',
      contentCutoffAt: '2026-09-11T11:00:00Z',
      jurisdiction: 'texas-education',
      workbookSha256: 'c'.repeat(64),
      approvedDomainAllowlistPath: 'approved_domains.txt',
      approvedDomainAllowlistSha256: 'd'.repeat(64),
    } as const;
    expect(
      validateLegacyContactManifest({
        ...base,
        files: [
          {
            path: 'accepted.jsonl.gz',
            sha256: 'a'.repeat(64),
            archiveUrl: `https://api.github.com/repos/aidaanswers21/public-workforce-data/git/blobs/${'b'.repeat(40)}`,
          },
        ],
      }).files[0]?.archiveUrl,
    ).toContain('/git/blobs/');
    expect(() =>
      validateLegacyContactManifest({
        ...base,
        files: [
          {
            path: 'accepted.jsonl.gz',
            sha256: 'a'.repeat(64),
            archiveUrl: 'https://github.com/aidaanswers21/public-workforce-data/blob/main/file',
          },
        ],
      }),
    ).toThrow('not an immutable GitHub git-blob URL');
  });

  it('enforces the workbook-approved domain allowlist', () => {
    expect(
      prepareLegacyContact(row, index, 'batch-2', 17, new Set(['killeenisd.org'])).status,
    ).toBe('accepted');
    expect(prepareLegacyContact(row, index, 'batch-2', 17, new Set(['example.edu']))).toEqual({
      status: 'quarantined',
      reason: 'source page domain is outside the workbook-approved allowlist',
    });
  });
});
