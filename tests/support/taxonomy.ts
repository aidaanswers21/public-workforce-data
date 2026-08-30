import { Taxonomy, type SectorPack } from '@pan/taxonomy';
import { educationSectorPack } from '@pan/sector-education';
import { federalGovernmentSectorPack } from '@pan/sector-federal';
import { stateLocalGovernmentSectorPack } from '@pan/sector-state-local';
import { buildTitleRuleSet } from '@pan/crawler-worker';
import type { TitleRuleSet } from '@pan/core';

/** Every shipped sector, composed exactly as the crawler worker composes it. */
export function allSectorsTaxonomy(extra: readonly SectorPack[] = []): Taxonomy {
  return new Taxonomy([
    educationSectorPack,
    stateLocalGovernmentSectorPack,
    federalGovernmentSectorPack,
    ...extra,
  ]);
}

export function titleRulesFor(taxonomy: Taxonomy): TitleRuleSet {
  return buildTitleRuleSet(taxonomy);
}
