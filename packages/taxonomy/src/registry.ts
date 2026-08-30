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
  organizationTypes?: readonly OrganizationTypeRow[];
  identifierSystems?: readonly IdentifierSystemRow[];
  geographicAreaTypes?: readonly ReferenceRow[];
  jobFamilies?: readonly ReferenceRow[];
  roleCategories?: readonly RoleCategoryRow[];
  titleRules?: readonly TitleRule[];
  titleAbbreviations?: readonly TitleAbbreviation[];
  specialtyPatterns?: readonly RegExp[];
  vocabulary?: Partial<DirectoryVocabulary>;
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

  private readonly organizationTypeIndex: ReadonlyMap<string, OrganizationTypeRow>;
  private readonly roleCategoryIndex: ReadonlyMap<string, RoleCategoryRow>;
  private readonly identifierSystemIndex: ReadonlyMap<string, IdentifierSystemRow>;

  constructor(packs: readonly SectorPack[] = []) {
    this.packs = packs;

    this.organizationTypes = mergeRows(
      BASE_ORGANIZATION_TYPES,
      packs.flatMap((p) => p.organizationTypes ?? []),
    );
    this.identifierSystems = mergeRows(
      BASE_IDENTIFIER_SYSTEMS,
      packs.flatMap((p) => p.identifierSystems ?? []),
    );
    this.geographicAreaTypes = mergeRows(
      BASE_GEOGRAPHIC_AREA_TYPES,
      packs.flatMap((p) => p.geographicAreaTypes ?? []),
    );
    this.jobFamilies = mergeRows(
      BASE_JOB_FAMILIES,
      packs.flatMap((p) => p.jobFamilies ?? []),
    );
    this.roleCategories = mergeRows(
      BASE_ROLE_CATEGORIES,
      packs.flatMap((p) => p.roleCategories ?? []),
    );

    // Sector rules are tried before the neutral base, because a vertical's own
    // vocabulary is more specific than the general public-sector one.
    this.titleRules = [
      ...packs.flatMap((pack) =>
        (pack.titleRules ?? []).map((rule) => ({ ...rule, source: rule.source ?? pack.key })),
      ),
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

  /** Organization type codes at one level of government. */
  organizationTypesForLevel(governmentLevelCode: string): readonly OrganizationTypeRow[] {
    return this.organizationTypes.filter((row) => row.governmentLevelCode === governmentLevelCode);
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
      if (!levels.has(type.governmentLevelCode)) {
        problems.push(
          `organization type "${type.code}" names unknown government level "${type.governmentLevelCode}"`,
        );
      }
      if (!sectors.has(type.sectorCode)) {
        problems.push(`organization type "${type.code}" names unknown sector "${type.sectorCode}"`);
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

/** Later rows with the same code replace earlier ones, so a pack can refine a base row. */
function mergeRows<T extends ReferenceRow>(base: readonly T[], extra: readonly T[]): readonly T[] {
  const byCode = new Map(base.map((row) => [row.code, row]));
  for (const row of extra) byCode.set(row.code, row);
  return [...byCode.values()];
}

/** The neutral taxonomy, with no sector packs. Used by tests of the core itself. */
export function baseTaxonomy(): Taxonomy {
  return new Taxonomy();
}
