import {
  BASE_GEOGRAPHIC_AREA_TYPES,
  BASE_IDENTIFIER_SYSTEMS,
  BASE_ORGANIZATION_TYPES,
  BASE_JOB_FAMILIES,
  BASE_ROLE_CATEGORIES,
  GOVERNMENT_LEVELS,
  RELATIONSHIP_TYPES,
  SECTORS,
  SOURCE_TYPES,
  EVIDENCE_CLASSES,
  CONTACT_POINT_TYPES,
  EXTRACTION_METHODS,
  OBFUSCATION_KINDS,
  indexByCode,
  type IdentifierSystemRow,
  type OrganizationTypeRow,
  type ReferenceRow,
  type RoleCategoryRow,
} from './reference/index.js';
import {
  BASE_DIRECTORY_VOCABULARY,
  composeVocabulary,
  type DirectoryVocabulary,
} from './vocabulary.js';
import {
  BASE_SPECIALTY_PATTERNS,
  BASE_TITLE_ABBREVIATIONS,
  BASE_TITLE_RULES,
  type TitleAbbreviation,
  type TitleRule,
} from './titles.js';

/**
 * Which organizations a pack's interpretive rules may be applied to.
 *
 * A null list is a wildcard for that dimension. Both dimensions must match, so
 * `{ sectorCodes: ['education'], governmentLevelCodes: null }` reads as
 * "education-sector work at any level of government", which is what education
 * actually is once `education` stops being a government level.
 *
 * Scope governs interpretation only: title rules, abbreviations, specialty
 * patterns and directory vocabulary. Reference rows a pack contributes
 * (organization types, role categories, identifier systems) are global by
 * nature, because a code has to resolve wherever it is stored.
 */
export interface SectorScope {
  sectorCodes: readonly string[] | null;
  governmentLevelCodes: readonly string[] | null;
}

/** The organization a rule set is being built for. */
export interface TaxonomyScope {
  sectorCode: string | null;
  governmentLevelCode: string | null;
}

export interface ExplorerAttributeColumn {
  key: string;
  label: string;
  format: 'integer' | 'decimal' | 'text';
}

/** A sector-owned view over neutral, provenance-bearing organization source records. */
export interface OrganizationExplorerPreset {
  key: string;
  name: string;
  singularName: string;
  description: string;
  organizationTypeCodes: readonly string[];
  sectorCodes: readonly string[];
  sourceKeys: readonly string[];
  attributeColumns: readonly ExplorerAttributeColumn[];
}

/**
 * What one public-sector vertical contributes to the shared vocabulary.
 *
 * A sector package exports one of these. It adds organization types, identifier
 * systems, role categories, title rules and directory words; it never changes
 * how any of them are interpreted, which is why registering a sector cannot
 * alter behaviour for any other sector.
 */
export interface SectorPack {
  key: string;
  displayName: string;
  description: string;
  /**
   * Which organizations this pack's title rules and vocabulary may classify.
   *
   * Required, because an unscoped pack silently classifies every record in the
   * platform. A pack that genuinely applies everywhere says so explicitly with
   * two nulls.
   */
  appliesTo: SectorScope;
  /**
   * Reference codes this pack intentionally replaces.
   *
   * Redefining a code another pack or the base already defines is refused
   * unless the code is listed here, so a collision is a start-up failure rather
   * than a silent overwrite whose winner depends on registration order.
   */
  overrides?: readonly string[];
  organizationTypes?: readonly OrganizationTypeRow[];
  identifierSystems?: readonly IdentifierSystemRow[];
  geographicAreaTypes?: readonly ReferenceRow[];
  jobFamilies?: readonly ReferenceRow[];
  roleCategories?: readonly RoleCategoryRow[];
  titleRules?: readonly TitleRule[];
  titleAbbreviations?: readonly TitleAbbreviation[];
  specialtyPatterns?: readonly RegExp[];
  vocabulary?: Partial<DirectoryVocabulary>;
  explorerPresets?: readonly OrganizationExplorerPreset[];
}

/** Raised when two packs, or a pack and the base, define the same code. */
export class ReferenceCollisionError extends Error {
  constructor(readonly collisions: readonly string[]) {
    super(`sector packs collide on reference data:\n  ${collisions.join('\n  ')}`);
    this.name = 'ReferenceCollisionError';
  }
}

/**
 * The composed vocabulary the rest of the platform reads.
 *
 * Built once at start-up from the base plus every registered sector. Nothing
 * downstream needs to know which pack contributed a given code.
 */
export class Taxonomy {
  readonly governmentLevels: readonly ReferenceRow[] = GOVERNMENT_LEVELS;
  readonly sectors: readonly ReferenceRow[] = SECTORS;
  readonly relationshipTypes = RELATIONSHIP_TYPES;
  readonly sourceTypes: readonly ReferenceRow[] = SOURCE_TYPES;
  readonly evidenceClasses: readonly ReferenceRow[] = EVIDENCE_CLASSES;
  readonly contactPointTypes: readonly ReferenceRow[] = CONTACT_POINT_TYPES;
  readonly extractionMethods: readonly ReferenceRow[] = EXTRACTION_METHODS;
  readonly obfuscationKinds: readonly ReferenceRow[] = OBFUSCATION_KINDS;

  readonly organizationTypes: readonly OrganizationTypeRow[];
  readonly identifierSystems: readonly IdentifierSystemRow[];
  readonly geographicAreaTypes: readonly ReferenceRow[];
  readonly jobFamilies: readonly ReferenceRow[];
  readonly roleCategories: readonly RoleCategoryRow[];
  readonly titleRules: readonly TitleRule[];
  readonly titleAbbreviations: readonly TitleAbbreviation[];
  readonly specialtyPatterns: readonly RegExp[];
  readonly vocabulary: DirectoryVocabulary;
  readonly packs: readonly SectorPack[];
  readonly explorerPresets: readonly OrganizationExplorerPreset[];

  private readonly scopedTitleRules: readonly ScopedRuleSource[];
  private readonly scopedCache = new Map<string, ScopedTaxonomy>();
  private readonly organizationTypeIndex: ReadonlyMap<string, OrganizationTypeRow>;
  private readonly roleCategoryIndex: ReadonlyMap<string, RoleCategoryRow>;
  private readonly identifierSystemIndex: ReadonlyMap<string, IdentifierSystemRow>;

  constructor(packs: readonly SectorPack[] = []) {
    this.packs = packs;
    this.explorerPresets = packs.flatMap((pack) => pack.explorerPresets ?? []);

    const presetKeys = this.explorerPresets.map((preset) => preset.key);
    if (new Set(presetKeys).size !== presetKeys.length) {
      throw new ReferenceCollisionError(['organization explorer preset keys must be unique']);
    }

    const collisions: string[] = [];
    const merge = <T extends ReferenceRow>(
      kind: string,
      base: readonly T[],
      select: (pack: SectorPack) => readonly T[] | undefined,
    ): readonly T[] => mergeReferenceRows(kind, base, packs, select, collisions);

    this.organizationTypes = merge(
      'organization type',
      BASE_ORGANIZATION_TYPES,
      (pack) => pack.organizationTypes,
    );
    this.identifierSystems = merge(
      'identifier system',
      BASE_IDENTIFIER_SYSTEMS,
      (pack) => pack.identifierSystems,
    );
    this.geographicAreaTypes = merge(
      'geographic area type',
      BASE_GEOGRAPHIC_AREA_TYPES,
      (pack) => pack.geographicAreaTypes,
    );
    this.jobFamilies = merge('job family', BASE_JOB_FAMILIES, (pack) => pack.jobFamilies);
    this.roleCategories = merge(
      'role category',
      BASE_ROLE_CATEGORIES,
      (pack) => pack.roleCategories,
    );

    // Government levels and sectors are the axes every other code is described
    // against, so a pack may not contribute to them at all. Catching an attempt
    // here is cheaper than discovering a pack invented a level later.
    for (const pack of packs) {
      const contributed = pack as unknown as Record<string, unknown>;
      for (const forbidden of [
        'governmentLevels',
        'sectors',
        'relationshipTypes',
        'extractionMethods',
        'obfuscationKinds',
      ]) {
        if (contributed[forbidden] !== undefined) {
          collisions.push(
            `pack "${pack.key}" contributes ${forbidden}, which only the neutral base may define`,
          );
        }
      }
    }

    if (collisions.length > 0) throw new ReferenceCollisionError(collisions);

    // Scoped rule sources, in registration order, ahead of the neutral base.
    // Selection happens later, per organization, in `scopedTitleRules`.
    this.scopedTitleRules = packs.map((pack) => ({
      scope: pack.appliesTo,
      key: pack.key,
      rules: (pack.titleRules ?? []).map((rule) => ({ ...rule, source: rule.source ?? pack.key })),
      abbreviations: pack.titleAbbreviations ?? [],
      specialtyPatterns: pack.specialtyPatterns ?? [],
      vocabulary: pack.vocabulary ?? {},
    }));

    this.titleRules = [
      ...this.scopedTitleRules.flatMap((entry) => entry.rules),
      ...BASE_TITLE_RULES.map((rule) => ({ ...rule, source: rule.source ?? 'base' })),
    ];
    this.titleAbbreviations = [
      ...packs.flatMap((pack) => pack.titleAbbreviations ?? []),
      ...BASE_TITLE_ABBREVIATIONS,
    ];
    this.specialtyPatterns = [
      ...packs.flatMap((pack) => pack.specialtyPatterns ?? []),
      ...BASE_SPECIALTY_PATTERNS,
    ];
    this.vocabulary = composeVocabulary(
      BASE_DIRECTORY_VOCABULARY,
      packs.map((pack) => pack.vocabulary ?? {}),
    );

    this.organizationTypeIndex = indexByCode(this.organizationTypes);
    this.roleCategoryIndex = indexByCode(this.roleCategories);
    this.identifierSystemIndex = indexByCode(this.identifierSystems);

    this.assertCoherent();
  }

  organizationType(code: string): OrganizationTypeRow | null {
    return this.organizationTypeIndex.get(code) ?? null;
  }

  roleCategory(code: string): RoleCategoryRow | null {
    return this.roleCategoryIndex.get(code) ?? null;
  }

  identifierSystem(code: string): IdentifierSystemRow | null {
    return this.identifierSystemIndex.get(code) ?? null;
  }

  /**
   * Organization types whose *default* level is the one asked for.
   *
   * A default, not a filter on real data: a `school_district` has no default
   * level and still exists at several. Use it to suggest a level during
   * onboarding, never to decide what an organization is.
   */
  organizationTypesDefaultingToLevel(governmentLevelCode: string): readonly OrganizationTypeRow[] {
    return this.organizationTypes.filter(
      (row) => row.defaultGovernmentLevelCode === governmentLevelCode,
    );
  }

  /**
   * The interpretive vocabulary for one organization.
   *
   * Precedence is fixed and deterministic:
   *
   *   1. Sector packs whose scope matches this organization, in the order they
   *      were registered.
   *   2. The neutral base, which always applies.
   *
   * First match wins within that order, so a matching sector rule beats the
   * base and an out-of-scope sector rule is not consulted at all. That is what
   * stops an education rule classifying a federal contracting officer and a
   * federal abbreviation expanding inside a school district.
   */
  forScope(scope: TaxonomyScope): ScopedTaxonomy {
    const key = `${scope.sectorCode ?? '*'}|${scope.governmentLevelCode ?? '*'}`;
    const cached = this.scopedCache.get(key);
    if (cached !== undefined) return cached;

    const applicable = this.scopedTitleRules.filter((entry) => scopeMatches(entry.scope, scope));
    const built: ScopedTaxonomy = {
      scope,
      packKeys: applicable.map((entry) => entry.key),
      titleRules: [
        ...applicable.flatMap((entry) => entry.rules),
        ...BASE_TITLE_RULES.map((rule) => ({ ...rule, source: rule.source ?? 'base' })),
      ],
      titleAbbreviations: [
        ...applicable.flatMap((entry) => entry.abbreviations),
        ...BASE_TITLE_ABBREVIATIONS,
      ],
      specialtyPatterns: [
        ...applicable.flatMap((entry) => entry.specialtyPatterns),
        ...BASE_SPECIALTY_PATTERNS,
      ],
      vocabulary: composeVocabulary(
        BASE_DIRECTORY_VOCABULARY,
        applicable.map((entry) => entry.vocabulary),
      ),
    };
    this.scopedCache.set(key, built);
    return built;
  }

  /**
   * Every code a pack references must resolve. Catching this at construction
   * turns a whole class of typo into a start-up failure rather than a row that
   * silently lands in the `other` bucket.
   */
  private assertCoherent(): void {
    const levels = new Set(this.governmentLevels.map((row) => row.code));
    const sectors = new Set(this.sectors.map((row) => row.code));
    const families = new Set(this.jobFamilies.map((row) => row.code));
    const roles = new Set(this.roleCategories.map((row) => row.code));
    const problems: string[] = [];

    for (const type of this.organizationTypes) {
      const level = type.defaultGovernmentLevelCode;
      if (level !== null && !levels.has(level)) {
        problems.push(`organization type "${type.code}" names unknown government level "${level}"`);
      }
      const sector = type.defaultSectorCode;
      if (sector !== null && !sectors.has(sector)) {
        problems.push(`organization type "${type.code}" names unknown sector "${sector}"`);
      }
    }
    for (const pack of this.packs) {
      for (const code of pack.appliesTo.sectorCodes ?? []) {
        if (!sectors.has(code)) {
          problems.push(`pack "${pack.key}" is scoped to unknown sector "${code}"`);
        }
      }
      for (const code of pack.appliesTo.governmentLevelCodes ?? []) {
        if (!levels.has(code)) {
          problems.push(`pack "${pack.key}" is scoped to unknown government level "${code}"`);
        }
      }
    }
    for (const role of this.roleCategories) {
      if (!families.has(role.jobFamilyCode)) {
        problems.push(
          `role category "${role.code}" names unknown job family "${role.jobFamilyCode}"`,
        );
      }
    }
    for (const rule of this.titleRules) {
      if (!roles.has(rule.roleCategoryCode)) {
        problems.push(
          `title rule ${rule.test.source} names unknown role category "${rule.roleCategoryCode}"`,
        );
      }
    }
    if (problems.length > 0) {
      throw new Error(`taxonomy is incoherent:\n  ${problems.join('\n  ')}`);
    }
  }
}

/** One pack's interpretive contribution, kept with the scope that governs it. */
interface ScopedRuleSource {
  scope: SectorScope;
  key: string;
  rules: readonly TitleRule[];
  abbreviations: readonly TitleAbbreviation[];
  specialtyPatterns: readonly RegExp[];
  vocabulary: Partial<DirectoryVocabulary>;
}

/** The vocabulary that applies to one organization, and nothing else. */
export interface ScopedTaxonomy {
  scope: TaxonomyScope;
  /** Which packs contributed, in precedence order. Recorded for audit. */
  packKeys: readonly string[];
  titleRules: readonly TitleRule[];
  titleAbbreviations: readonly TitleAbbreviation[];
  specialtyPatterns: readonly RegExp[];
  vocabulary: DirectoryVocabulary;
}

/**
 * Does a pack's scope cover this organization?
 *
 * Both dimensions must match. A null list is a wildcard for that dimension, and
 * an organization that states neither sector nor level matches only wildcards,
 * because guessing the missing half is how a rule ends up applied to a record
 * nobody classified.
 */
function scopeMatches(packScope: SectorScope, target: TaxonomyScope): boolean {
  const sectorOk =
    packScope.sectorCodes === null ||
    (target.sectorCode !== null && packScope.sectorCodes.includes(target.sectorCode));
  const levelOk =
    packScope.governmentLevelCodes === null ||
    (target.governmentLevelCode !== null &&
      packScope.governmentLevelCodes.includes(target.governmentLevelCode));
  return sectorOk && levelOk;
}

/**
 * Merge base rows with every pack's, refusing silent overwrites.
 *
 * Two packs defining the same code, or a pack redefining a base code, used to
 * resolve by registration order: last writer won, invisibly, and which pack
 * that was depended on an argument list in another file. Now it is an error
 * unless the pack names the code in `overrides`, which makes the intent
 * reviewable in the diff.
 */
function mergeReferenceRows<T extends ReferenceRow>(
  kind: string,
  base: readonly T[],
  packs: readonly SectorPack[],
  select: (pack: SectorPack) => readonly T[] | undefined,
  collisions: string[],
): readonly T[] {
  const byCode = new Map<string, T>(base.map((row) => [row.code, row]));
  const owner = new Map<string, string>(base.map((row) => [row.code, 'the neutral base']));

  for (const pack of packs) {
    const overrides = new Set(pack.overrides ?? []);
    const seenInThisPack = new Set<string>();
    for (const row of select(pack) ?? []) {
      if (seenInThisPack.has(row.code)) {
        collisions.push(`pack "${pack.key}" defines ${kind} "${row.code}" twice`);
        continue;
      }
      seenInThisPack.add(row.code);
      const existing = owner.get(row.code);
      if (existing !== undefined && !overrides.has(row.code)) {
        collisions.push(
          `pack "${pack.key}" redefines ${kind} "${row.code}", already defined by ${existing}; ` +
            `list it in the pack's "overrides" if that is intended`,
        );
        continue;
      }
      byCode.set(row.code, row);
      owner.set(row.code, `pack "${pack.key}"`);
    }
  }
  return [...byCode.values()];
}

/** The neutral taxonomy, with no sector packs. Used by tests of the core itself. */
export function baseTaxonomy(): Taxonomy {
  return new Taxonomy();
}
