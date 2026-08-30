import { AdapterRegistry } from '@pan/adapter-kit';
import { genericHtmlAdapter } from '@pan/adapter-generic-html';
import { genericJsonAdapter } from '@pan/adapter-generic-json';
import { JurisdictionRegistry } from '@pan/jurisdiction-kit';
import { texasEducationJurisdiction } from '@pan/jurisdiction-texas-education';
import { educationSectorPack } from '@pan/sector-education';
import { federalGovernmentSectorPack } from '@pan/sector-federal';
import { stateLocalGovernmentSectorPack } from '@pan/sector-state-local';
import { SENIORITY_MODIFIERS, Taxonomy, US_LOCALITY_DOMAIN_LABELS } from '@pan/taxonomy';
import { hashObject, withPolicyDefaults, type CrawlPolicy, type TitleRuleSet } from '@pan/core';

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
    packs: taxonomy.packs.map((pack) => pack.key),
    rules: taxonomy.titleRules.map(
      (rule) => `${rule.source ?? ''}:${rule.test.source}:${rule.roleCategoryCode}`,
    ),
    roles: taxonomy.roleCategories.map((row) => row.code),
  }).slice(0, 16);
}

export function buildTitleRuleSet(taxonomy: Taxonomy): TitleRuleSet {
  const jobFamilyByRole = new Map(
    taxonomy.roleCategories.map((row) => [row.code, row.jobFamilyCode]),
  );
  return {
    rules: taxonomy.titleRules,
    abbreviations: taxonomy.titleAbbreviations,
    seniorityModifiers: SENIORITY_MODIFIERS,
    specialtyPatterns: taxonomy.specialtyPatterns,
    fallbackRoleCategoryCode: 'other',
    unknownRoleCategoryCode: 'unknown',
    jobFamilyForRole: (code) => jobFamilyByRole.get(code) ?? 'unknown',
    version: taxonomyVersion(taxonomy),
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
  return new JurisdictionRegistry().register(texasEducationJurisdiction);
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
