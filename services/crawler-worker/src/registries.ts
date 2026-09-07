import { AdapterRegistry } from '@public-workforce/adapter-kit';
import { genericHtmlAdapter } from '@public-workforce/adapter-generic-html';
import { genericJsonAdapter } from '@public-workforce/adapter-generic-json';
import { JurisdictionRegistry } from '@public-workforce/jurisdiction-kit';
import { texasEducationJurisdiction } from '@public-workforce/jurisdiction-texas-education';
import {
  nationalOrganizationSpineInventory,
  nationalSpineJurisdictions,
} from '@public-workforce/jurisdiction-us-national-spine';
import { educationSectorPack } from '@public-workforce/sector-education';
import { federalGovernmentSectorPack } from '@public-workforce/sector-federal';
import { stateLocalGovernmentSectorPack } from '@public-workforce/sector-state-local';
import {
  SENIORITY_MODIFIERS,
  Taxonomy,
  US_LOCALITY_DOMAIN_LABELS,
  type TaxonomyScope,
} from '@public-workforce/taxonomy';
import {
  hashObject,
  withPolicyDefaults,
  type CrawlPolicy,
  type TitleRuleSet,
} from '@public-workforce/core';
import type { DirectoryVocabulary } from '@public-workforce/shared-types';

/**
 * The composition root.
 *
 * Three registries, each extended by one line: a sector pack, a directory
 * adapter, a jurisdiction configuration. Nothing else in the platform changes
 * when any of them grows, which is the property `tests/extensibility.test.ts`
 * asserts by building all three inside the test file.
 */
export function buildTaxonomy(): Taxonomy {
  return new Taxonomy([
    // Order matters only for title rules: the first pack whose rule matches
    // wins, and the neutral base is always tried last.
    educationSectorPack,
    stateLocalGovernmentSectorPack,
    federalGovernmentSectorPack,
  ]);
}

/**
 * A version string derived from the rules themselves.
 *
 * Recorded on every normalized title, so two runs can be compared and a
 * re-normalization after a taxonomy change is visible rather than silent.
 * Deriving it from content means nobody has to remember to bump it.
 */
export function taxonomyVersion(taxonomy: Taxonomy): string {
  return hashObject({
    packs: taxonomy.packs.map((pack) => ({ key: pack.key, scope: pack.appliesTo })),
    rules: taxonomy.titleRules.map(
      (rule) => `${rule.source ?? ''}:${rule.test.source}:${rule.roleCategoryCode}`,
    ),
    roles: taxonomy.roleCategories.map((row) => row.code),
  }).slice(0, 16);
}

/**
 * The title rules that apply to one organization.
 *
 * Scope is required, not optional. A rule set built without one would be the
 * union of every pack, which is how an education rule ends up classifying a
 * federal contracting officer. Passing `{ sectorCode: null, governmentLevelCode:
 * null }` is legal and means "the neutral base only", which is the right answer
 * for an organization nobody has classified yet.
 *
 * The version is the whole taxonomy's, not the scoped subset's, so two records
 * normalized under the same taxonomy compare equal even when different packs
 * applied to them.
 */
export function buildTitleRuleSet(taxonomy: Taxonomy, scope: TaxonomyScope): TitleRuleSet {
  const jobFamilyByRole = new Map(
    taxonomy.roleCategories.map((row) => [row.code, row.jobFamilyCode]),
  );
  const scoped = taxonomy.forScope(scope);
  return {
    rules: scoped.titleRules,
    abbreviations: scoped.titleAbbreviations,
    seniorityModifiers: SENIORITY_MODIFIERS,
    specialtyPatterns: scoped.specialtyPatterns,
    fallbackRoleCategoryCode: 'other',
    unknownRoleCategoryCode: 'unknown',
    jobFamilyForRole: (code) => jobFamilyByRole.get(code) ?? 'unknown',
    version: taxonomyVersion(taxonomy),
  };
}

/**
 * Everything interpretive that one organization's records should be read with.
 *
 * Vocabulary and title rules travel together because they answer the same
 * question from two directions: what words this kind of body uses on its pages,
 * and what its job titles mean. Building them from one scope keeps them from
 * drifting apart, which is how a directory gets parsed with education headings
 * and then classified with federal rules.
 */
export function buildScopedRules(
  taxonomy: Taxonomy,
  scope: TaxonomyScope,
): { vocabulary: DirectoryVocabulary; titleRules: TitleRuleSet; packKeys: readonly string[] } {
  const scoped = taxonomy.forScope(scope);
  return {
    vocabulary: scoped.vocabulary,
    titleRules: buildTitleRuleSet(taxonomy, scope),
    packKeys: scoped.packKeys,
  };
}

/**
 * Adapters, most specific first.
 *
 * Selection is by score rather than order, but registering specific platforms
 * ahead of generic ones keeps ties deterministic in the sensible direction.
 */
export function buildAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(genericJsonAdapter).register(genericHtmlAdapter);
}

export function buildJurisdictionRegistry(): JurisdictionRegistry {
  const registry = new JurisdictionRegistry().register(texasEducationJurisdiction);
  for (const config of nationalSpineJurisdictions) registry.register(config);
  return registry;
}

export function buildOrganizationSpineInventory() {
  return nationalOrganizationSpineInventory;
}

/**
 * Crawl policy with the platform's own defaults filled in.
 *
 * The locality domain labels come from the taxonomy rather than the core, so
 * the crawler treats `co.harris.tx.us` and `ci.austin.tx.us` as different sites
 * instead of collapsing every public body in a state onto one.
 */
export function buildCrawlPolicy(overrides: Partial<CrawlPolicy> = {}): CrawlPolicy {
  return withPolicyDefaults({ localityDomainLabels: US_LOCALITY_DOMAIN_LABELS, ...overrides });
}
