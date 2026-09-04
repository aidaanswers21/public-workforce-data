import { Taxonomy, type SectorPack, type TaxonomyScope } from '@public-workforce/taxonomy';
import { educationSectorPack } from '@public-workforce/sector-education';
import { federalGovernmentSectorPack } from '@public-workforce/sector-federal';
import { stateLocalGovernmentSectorPack } from '@public-workforce/sector-state-local';
import { buildTitleRuleSet } from '@public-workforce/crawler-worker';
import type { TitleRuleSet } from '@public-workforce/core';

/** Every shipped sector, composed exactly as the crawler worker composes it. */
export function allSectorsTaxonomy(extra: readonly SectorPack[] = []): Taxonomy {
  return new Taxonomy([
    educationSectorPack,
    stateLocalGovernmentSectorPack,
    federalGovernmentSectorPack,
    ...extra,
  ]);
}

/**
 * The rules that apply to one organization.
 *
 * A scope is required, because an unscoped rule set is the union of every pack
 * and would let one vertical classify another's people. `NEUTRAL_SCOPE` asks
 * for the base only.
 */
export function titleRulesFor(taxonomy: Taxonomy, scope: TaxonomyScope): TitleRuleSet {
  return buildTitleRuleSet(taxonomy, scope);
}

/** No sector and no level: the neutral base and nothing else. */
export const NEUTRAL_SCOPE: TaxonomyScope = { sectorCode: null, governmentLevelCode: null };

/** An independent school district: education work at the special-district level. */
export const EDUCATION_SCOPE: TaxonomyScope = {
  sectorCode: 'education',
  governmentLevelCode: 'special_district',
};

/** A federal body doing general-government work. */
export const FEDERAL_SCOPE: TaxonomyScope = {
  sectorCode: 'general_government',
  governmentLevelCode: 'federal',
};

/** A county doing general-government work. */
export const STATE_LOCAL_SCOPE: TaxonomyScope = {
  sectorCode: 'general_government',
  governmentLevelCode: 'county',
};
