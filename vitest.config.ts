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
      '@public-workforce/shared-types': source('packages/shared-types'),
      '@public-workforce/taxonomy': source('packages/taxonomy'),
      '@public-workforce/observability': source('packages/observability'),
      '@public-workforce/core': source('packages/core'),
      '@public-workforce/extraction': source('packages/extraction'),
      '@public-workforce/database': source('packages/database'),
      '@public-workforce/adapter-kit': source('packages/directory-adapters/kit'),
      '@public-workforce/adapter-generic-html': source('packages/directory-adapters/generic-html'),
      '@public-workforce/adapter-generic-json': source('packages/directory-adapters/generic-json'),
      '@public-workforce/sector-education': source('packages/sectors/education'),
      '@public-workforce/sector-state-local': source('packages/sectors/state-local-government'),
      '@public-workforce/sector-federal': source('packages/sectors/federal-government'),
      '@public-workforce/jurisdiction-kit': source('packages/jurisdiction-config/kit'),
      '@public-workforce/jurisdiction-texas-education': source(
        'packages/jurisdiction-config/texas-education',
      ),
      '@public-workforce/jurisdiction-us-national-spine': source(
        'packages/jurisdiction-config/us-national-spine',
      ),
      '@public-workforce/crawler-worker': source('services/crawler-worker'),
      '@public-workforce/discovery-worker': source('services/discovery-worker'),
      '@public-workforce/validation-worker': source('services/validation-worker'),
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
