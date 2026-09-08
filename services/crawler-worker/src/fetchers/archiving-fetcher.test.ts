import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { contentHash } from '@public-workforce/core';
import type { Fetcher, FetchedPage } from '@public-workforce/shared-types';
import { ArchivingFetcher, S3ResponseArchive } from './archiving-fetcher.js';

const page: FetchedPage = {
  url: 'https://agency.example.gov/directory',
  finalUrl: 'https://agency.example.gov/directory',
  status: 200,
  headers: { 'content-type': 'text/html' },
  body: '<p>Published staff directory</p>',
  contentType: 'text/html',
  fetchedAt: '2026-09-08T00:00:00.000Z',
  contentHash: contentHash('<p>Published staff directory</p>'),
  fromCache: false,
};

describe('production response archiving', () => {
  it('compresses exact response bytes and returns a content-addressed private key', async () => {
    const send = vi.fn().mockResolvedValue({});
    const archive = new S3ResponseArchive(
      {
        endpoint: 'https://storage.example.test',
        region: 'auto',
        bucket: 'private-evidence',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
      },
      { send },
    );

    const storageKey = await archive.archive(page);

    expect(storageKey).toMatch(/^s3:\/\/private-evidence\/source-responses\//);
    const command = send.mock.calls[0]?.[0];
    expect(command.input.Bucket).toBe('private-evidence');
    expect(command.input.ContentEncoding).toBe('gzip');
    expect(gunzipSync(command.input.Body).toString('utf8')).toBe(page.body);
  });

  it('does not expose a successful fetch until the archive upload succeeds', async () => {
    const inner: Fetcher = {
      key: 'test',
      fetch: vi.fn().mockResolvedValue({ ok: true, page }),
    };
    const archive = new S3ResponseArchive(
      {
        endpoint: 'https://storage.example.test',
        region: 'auto',
        bucket: 'private-evidence',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
      },
      { send: vi.fn().mockRejectedValue(new Error('archive unavailable')) },
    );

    await expect(new ArchivingFetcher(inner, archive).fetch({ url: page.url })).rejects.toThrow(
      'archive unavailable',
    );
  });
});
