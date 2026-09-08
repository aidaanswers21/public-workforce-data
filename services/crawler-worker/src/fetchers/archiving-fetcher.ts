import { gzipSync } from 'node:zlib';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { sha256, urlHash } from '@public-workforce/core';
import type {
  FetchOutcome,
  FetchRequest,
  Fetcher,
  FetchedPage,
} from '@public-workforce/shared-types';

export interface S3ArchiveOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  forcePathStyle?: boolean;
}

interface ObjectWriter {
  send(command: PutObjectCommand): Promise<unknown>;
}

/** Stores exact successful response bodies before production code can parse them. */
export class S3ResponseArchive {
  private readonly client: ObjectWriter;
  private readonly prefix: string;

  constructor(
    private readonly options: S3ArchiveOptions,
    client?: ObjectWriter,
  ) {
    this.prefix = cleanPrefix(options.prefix ?? 'source-responses');
    this.client =
      client ??
      new S3Client({
        endpoint: options.endpoint,
        region: options.region,
        forcePathStyle: options.forcePathStyle ?? true,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
      });
  }

  async archive(page: FetchedPage): Promise<string> {
    const rawContentHash = sha256(page.body);
    const key = `${this.prefix}/${urlHash(page.finalUrl)}/${rawContentHash}.gz`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: gzipSync(Buffer.from(page.body, 'utf8')),
        ContentType: page.contentType ?? 'application/octet-stream',
        ContentEncoding: 'gzip',
        Metadata: {
          'content-sha256': page.contentHash,
          'raw-content-sha256': rawContentHash,
          'source-url-sha256': urlHash(page.finalUrl),
          'fetched-at': page.fetchedAt,
        },
      }),
    );
    return `s3://${this.options.bucket}/${key}`;
  }
}

/** A fetch succeeds only after the exact returned body is durably archived. */
export class ArchivingFetcher implements Fetcher {
  readonly key: string;

  constructor(
    private readonly inner: Fetcher,
    private readonly archive: S3ResponseArchive,
  ) {
    this.key = `${inner.key}+archive`;
  }

  async fetch(request: FetchRequest): Promise<FetchOutcome> {
    const outcome = await this.inner.fetch(request);
    if (!outcome.ok) return outcome;
    const storageKey = await this.archive.archive(outcome.page);
    return { ok: true, page: { ...outcome.page, storageKey } };
  }
}

function cleanPrefix(value: string): string {
  const cleaned = value.replace(/^\/+|\/+$/g, '');
  if (cleaned.length === 0) throw new Error('archive object prefix cannot be empty');
  return cleaned;
}
