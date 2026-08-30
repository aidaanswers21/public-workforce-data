import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Packages that must stay neutral across every public-sector vertical.
 *
 * Anything a particular vertical knows belongs in a sector package, a
 * jurisdiction configuration, a fixture or the documentation. If one of these
 * files starts naming schools, states or a specific directory platform, the
 * seam has leaked and this test says so.
 */
const NEUTRAL_PACKAGES = [
  'packages/core/src',
  'packages/shared-types/src',
  'packages/taxonomy/src',
  'packages/database/src',
  'packages/extraction/src',
  'packages/directory-adapters/kit/src',
  'packages/directory-adapters/generic-html/src',
  'packages/directory-adapters/generic-json/src',
  'packages/jurisdiction-config/kit/src',
  'services/crawler-worker/src/pipeline.ts',
  'services/discovery-worker/src',
  'services/validation-worker/src',
  'apps/admin/src',
  'apps/api/src',
];

/**
 * Terms that name one vertical and cannot be neutral.
 *
 * `district` is deliberately absent: special districts and congressional
 * districts are general-government concepts, so only the education sense of the
 * word is banned, via the "school district" phrase.
 */
const EDUCATION_TERMS = [
  'school',
  'schools',
  'teacher',
  'teachers',
  'faculty',
  'campus',
  'campuses',
  'student',
  'students',
  'classroom',
  'pupil',
  'curriculum',
  'isd',
  'nces',
  'k12',
  'kindergarten',
  'principal',
  'superintendent',
];

/** Directory platform vendors. An adapter may name its own platform; core may not. */
const PLATFORM_NAMES = [
  'finalsite',
  'schoolwires',
  'edlio',
  'blackboard',
  'powerschool',
  'civicplus',
  'granicus',
];

const STATE_NAMES = [
  'alabama',
  'alaska',
  'arizona',
  'arkansas',
  'california',
  'colorado',
  'connecticut',
  'delaware',
  'florida',
  'georgia',
  'hawaii',
  'idaho',
  'illinois',
  'indiana',
  'iowa',
  'kansas',
  'kentucky',
  'louisiana',
  'maine',
  'maryland',
  'massachusetts',
  'michigan',
  'minnesota',
  'mississippi',
  'missouri',
  'montana',
  'nebraska',
  'nevada',
  'ohio',
  'oklahoma',
  'oregon',
  'pennsylvania',
  'tennessee',
  'texas',
  'utah',
  'vermont',
  'virginia',
  'washington',
  'wisconsin',
  'wyoming',
];

/**
 * Strip comments and string-literal-free prose before scanning.
 *
 * Documentation examples are explicitly allowed: a comment may say "a school
 * belongs to a district" to explain why the model is shaped as it is. What must
 * not appear is executable code that branches on one vertical.
 */
function stripCommentsAndStrings(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

/**
 * The single exemption, by exact path.
 *
 * `US_LOCALITY_DOMAIN_LABELS` is a table of DNS labels published under `.us`.
 * "k12" appears there beside "co", "ci" and "lib" as registry data, not as a
 * branch on a vertical, and the crawler needs all of them to tell one public
 * body's site from another's. Any further exemption should be argued for on the
 * same terms or refused.
 */
const EXEMPT_FILES = new Set(['packages/taxonomy/src/reference/domains.ts']);

function collectSourceFiles(target: string): string[] {
  const absolute = join(repoRoot, target);
  if (statSync(absolute).isFile()) return [absolute];
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      // Tests and fixtures may name any vertical they like.
      if (entry.endsWith('.test.ts')) continue;
      if (EXEMPT_FILES.has(relative(repoRoot, full))) continue;
      files.push(full);
    }
  };
  walk(absolute);
  return files;
}

const NEUTRAL_FILES = NEUTRAL_PACKAGES.flatMap(collectSourceFiles);

interface Leak {
  file: string;
  line: number;
  term: string;
  text: string;
}

function findLeaks(terms: readonly string[]): Leak[] {
  const leaks: Leak[] = [];
  for (const file of NEUTRAL_FILES) {
    const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
    const lines = code.split('\n');
    for (const [index, line] of lines.entries()) {
      for (const term of terms) {
        if (new RegExp(`\\b${term}\\b`, 'i').test(line)) {
          leaks.push({ file: relative(repoRoot, file), line: index + 1, term, text: line.trim() });
        }
      }
    }
  }
  return leaks;
}

describe('the neutral core carries no vertical-specific knowledge', () => {
  it('scans a meaningful number of files', () => {
    expect(NEUTRAL_FILES.length).toBeGreaterThan(25);
  });

  it('exempts exactly one file, and that file is only a table of DNS labels', () => {
    expect([...EXEMPT_FILES]).toEqual(['packages/taxonomy/src/reference/domains.ts']);
    const source = readFileSync(
      join(repoRoot, 'packages/taxonomy/src/reference/domains.ts'),
      'utf8',
    );
    // Data only: no imports, no functions, no branching.
    expect(source).not.toMatch(/\bimport\b/);
    expect(source).not.toMatch(/\bfunction\b/);
    expect(source).not.toMatch(/\bif\s*\(/);
  });

  it('contains no education-specific terms in executable code', () => {
    const leaks = findLeaks(EDUCATION_TERMS);
    expect(
      leaks,
      leaks
        .map((leak) => `${leak.file}:${leak.line} names "${leak.term}": ${leak.text}`)
        .join('\n'),
    ).toEqual([]);
  });

  it('names no directory platform vendor', () => {
    const leaks = findLeaks(PLATFORM_NAMES);
    expect(leaks.map((leak) => `${leak.file}:${leak.line} ${leak.term}`)).toEqual([]);
  });

  it('hard-codes no state name', () => {
    const leaks = findLeaks(STATE_NAMES);
    expect(leaks.map((leak) => `${leak.file}:${leak.line} ${leak.term}`)).toEqual([]);
  });

  it('imports no sector or jurisdiction package', () => {
    const offenders: string[] = [];
    for (const file of NEUTRAL_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from '(@pan\/(?:sector-|jurisdiction-)[a-z-]+)'/g)) {
        offenders.push(`${relative(repoRoot, file)} imports ${match[1] ?? ''}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the crawl engine depends on no adapter and no jurisdiction', () => {
    const source = readFileSync(join(repoRoot, 'packages/core/src/crawl/engine.ts'), 'utf8');
    expect(source).not.toMatch(/@pan\/adapter-/);
    expect(source).not.toMatch(/@pan\/jurisdiction-/);
    expect(source).not.toMatch(/@pan\/sector-/);
  });
});

describe('vertical knowledge lives where it belongs', () => {
  it('the education sector package is where education terms are allowed', () => {
    const source = readFileSync(join(repoRoot, 'packages/sectors/education/src/pack.ts'), 'utf8');
    expect(source).toMatch(/\bschool_district\b/);
    expect(source).toMatch(/\bteacher\b/);
  });

  it('the education extension is a separate module, not part of the core', () => {
    const files = collectSourceFiles('packages/sectors/education/src');
    expect(files.length).toBeGreaterThan(0);
    for (const file of NEUTRAL_FILES) {
      expect(file).not.toContain('sectors/education');
    }
  });

  it('the shipped jurisdiction is education for one state, not a state config', () => {
    const source = readFileSync(
      join(repoRoot, 'packages/jurisdiction-config/texas-education/src/index.ts'),
      'utf8',
    );
    expect(source).toMatch(/governmentLevelCode: 'education'/);
    expect(source).toMatch(/key: 'texas-education'/);
  });
});
