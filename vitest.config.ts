import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const source = (relativePath: string): string => resolve(root, relativePath, 'src/index.ts');

/**
 * Tests run against TypeScript sources, not build output.
 *
 * That keeps `pnpm test` usable without a build step and means a failing test
 * points at the file you edit rather than at a stale `dist`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@pan/shared-types': source('packages/shared-types'),
      '@pan/observability': source('packages/observability'),
      '@pan/core': source('packages/core'),
      '@pan/extraction': source('packages/extraction'),
      '@pan/database': source('packages/database'),
      '@pan/adapter-kit': source('packages/directory-adapters/kit'),
      '@pan/adapter-generic-html': source('packages/directory-adapters/generic-html'),
      '@pan/adapter-generic-json': source('packages/directory-adapters/generic-json'),
      '@pan/state-kit': source('packages/state-config/kit'),
      '@pan/state-texas': source('packages/state-config/texas'),
      '@pan/crawler-worker': source('services/crawler-worker'),
      '@pan/discovery-worker': source('services/discovery-worker'),
      '@pan/validation-worker': source('services/validation-worker'),
    },
  },
  test: {
    include: ['{packages,services,apps,tests}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
