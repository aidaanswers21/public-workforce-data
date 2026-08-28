import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterFixture } from '@pan/adapter-kit';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = resolve(here, '..', 'fixtures');

export function fixturePath(...parts: string[]): string {
  return join(FIXTURE_ROOT, ...parts);
}

export function readFixture(...parts: string[]): string {
  return readFileSync(fixturePath(...parts), 'utf8');
}

/** Load a directory-platform fixture and give it the URL it pretends to come from. */
export function loadAdapterFixture(input: {
  name: string;
  file: string;
  url: string;
  kind?: 'listing' | 'profile';
  contentType?: string;
  expected?: AdapterFixture['expected'];
}): AdapterFixture {
  return {
    name: input.name,
    url: input.url,
    html: readFixture('directory-platforms', input.file),
    kind: input.kind ?? 'listing',
    contentType: input.contentType ?? 'text/html; charset=utf-8',
    ...(input.expected === undefined ? {} : { expected: input.expected }),
  };
}
