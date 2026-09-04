import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
 * Strip comments before scanning executable source.
 *
 * Documentation examples are explicitly allowed: a comment may say "a school
 * belongs to a district" to explain why the model is shaped as it is. What must
 * not appear is executable code that branches on one vertical. String literals
 * remain because a vertical name in executable configuration is still a leak.
 */
function stripCommentsAndStrings(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

/**
 * Two exemptions, by exact path, each argued rather than assumed.
 *
 * `packages/taxonomy/src/reference/domains.ts` is a table of DNS labels
 * published under `.us`. "k12" appears there beside "co", "ci" and "lib" as
 * registry data, not as a branch on a vertical, and the crawler needs all of
 * them to tell one public body's site from another's.
 *
 * `packages/core/src/policy/data-boundary.ts` names "student" and "pupil" in
 * order to refuse them. That is the opposite of vertical logic: the boundary
 * exists to keep student information out of the platform, and a prohibition has
 * to name the thing it prohibits. Moving these patterns into the education
 * sector pack would be actively harmful, because the protection would then
 * apply only where an education pack happened to be registered, and a county
 * library or a parks department publishing a minor's details is exactly the
 * case nobody would have registered it for.
 *
 * Both files are further constrained by the test below. Any third exemption
 * should be argued on the same terms or refused.
 */
const EXEMPT_FILES = new Set([
  'packages/taxonomy/src/reference/domains.ts',
  'packages/core/src/policy/data-boundary.ts',
]);

function collectSourceFiles(target: string, root = repoRoot): string[] {
  const absolute = join(root, target);
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
      if (EXEMPT_FILES.has(relative(root, full))) continue;
      files.push(full);
    }
  };
  walk(absolute);
  return files;
}

function collectNeutralFiles(root = repoRoot): string[] {
  return NEUTRAL_PACKAGES.flatMap((target) => collectSourceFiles(target, root));
}

interface Leak {
  file: string;
  line: number;
  term: string;
  text: string;
}

function findLeaks(
  terms: readonly string[],
  files: readonly string[] = collectNeutralFiles(),
  root = repoRoot,
): Leak[] {
  const leaks: Leak[] = [];
  for (const file of files) {
    const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
    const lines = code.split('\n');
    for (const [index, line] of lines.entries()) {
      for (const term of terms) {
        if (new RegExp(`\\b${term}\\b`, 'i').test(line)) {
          leaks.push({ file: relative(root, file), line: index + 1, term, text: line.trim() });
        }
      }
    }
  }
  return leaks;
}

describe('the neutral core carries no vertical-specific knowledge', () => {
  it('scans a meaningful number of files', () => {
    expect(collectNeutralFiles().length).toBeGreaterThan(25);
  });

  it('discovers a new neutral source file and reports its prohibited knowledge', () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'neutral-guard-'));
    const sourceDirectory = join(isolatedRoot, 'packages/core/src');
    const probe = join(sourceDirectory, 'new-source.ts');
    try {
      mkdirSync(sourceDirectory, { recursive: true });
      writeFileSync(probe, "export const directoryVendor = 'blackboard';\n", 'utf8');
      const discovered = collectSourceFiles('packages/core/src', isolatedRoot);
      expect(discovered).toEqual([probe]);
      expect(findLeaks(PLATFORM_NAMES, discovered, isolatedRoot)).toEqual([
        {
          file: 'packages/core/src/new-source.ts',
          line: 1,
          term: 'blackboard',
          text: "export const directoryVendor = 'blackboard';",
        },
      ]);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it('exempts exactly two files, each for a stated reason', () => {
    expect([...EXEMPT_FILES]).toEqual([
      'packages/taxonomy/src/reference/domains.ts',
      'packages/core/src/policy/data-boundary.ts',
    ]);
  });

  it('the domain table is data only, with no logic to hide a branch in', () => {
    const source = readFileSync(
      join(repoRoot, 'packages/taxonomy/src/reference/domains.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\bimport\b/);
    expect(source).not.toMatch(/\bfunction\b/);
    expect(source).not.toMatch(/\bif\s*\(/);
  });

  it('the data boundary names a vertical only to refuse it, never to read it', () => {
    const source = readFileSync(
      join(repoRoot, 'packages/core/src/policy/data-boundary.ts'),
      'utf8',
    );
    let code = stripCommentsAndStrings(source);

    // Remove the prohibition machinery: the patterns that detect student and
    // guardian data, the kinds they raise, and the field list that exempts job
    // descriptions from them. Whatever education terms are left after that are
    // the platform reading a vertical rather than refusing one.
    const prohibitions = [
      /const STUDENT_SUBJECT_LABEL =[\s\S]*?;\n/,
      /const STUDENT_POSSESSIVE_LABEL =[\s\S]*?;\n/,
      /const STUDENT_VALUE =[\s\S]*?;\n/,
      /const GUARDIAN_LABEL =[\s\S]*?;\n/,
      /const ROLE_DESCRIPTION_FIELDS = new Set\(\[[\s\S]*?\]\);\n/,
      /'student_information',?\n/g,
      /'guardian_information',?\n/g,
      /kind: 'student_information',\n/,
      /kind: 'guardian_information',\n/,
      /STUDENT_SUBJECT_LABEL\.test\(label\)/,
      /STUDENT_POSSESSIVE_LABEL\.test\(label\)/,
      /STUDENT_VALUE\.test\(value\)/,
      /GUARDIAN_LABEL\.test\(label\)/,
      // The operator-facing message on a finding. A sentence, not a branch.
      /reason: '[^']*',?\n/g,
    ];
    for (const pattern of prohibitions) code = code.replace(pattern, ' ');

    const remaining = code
      .split('\n')
      .filter((line) => /\b(student|pupil|school|teacher|campus|k12|nces)\b/i.test(line))
      .map((line) => line.trim());
    expect(remaining, 'data boundary names a vertical outside a prohibition').toEqual([]);

    // And it imports nothing from a vertical, so it cannot consult one.
    expect(source).not.toMatch(/@public-workforce\/(sector-|jurisdiction-)/);
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
    for (const file of collectNeutralFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /from '(@public-workforce\/(?:sector-|jurisdiction-)[a-z-]+)'/g,
      )) {
        offenders.push(`${relative(repoRoot, file)} imports ${match[1] ?? ''}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the crawl engine depends on no adapter and no jurisdiction', () => {
    const source = readFileSync(join(repoRoot, 'packages/core/src/crawl/engine.ts'), 'utf8');
    expect(source).not.toMatch(/@public-workforce\/adapter-/);
    expect(source).not.toMatch(/@public-workforce\/jurisdiction-/);
    expect(source).not.toMatch(/@public-workforce\/sector-/);
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
    for (const file of collectNeutralFiles()) {
      expect(file).not.toContain('sectors/education');
    }
  });

  it('the shipped jurisdiction is education for one state, not a state config', () => {
    const source = readFileSync(
      join(repoRoot, 'packages/jurisdiction-config/texas-education/src/index.ts'),
      'utf8',
    );
    expect(source).toMatch(/key: 'texas-education'/);
    expect(source).toMatch(/sectorCodes: \['education'\]/);
    // Education is the sector; the level is what the body actually is.
    expect(source).not.toMatch(/governmentLevelCode: 'education'/);
    expect(source).toMatch(/governmentLevelCode: 'special_district'/);
  });
});
