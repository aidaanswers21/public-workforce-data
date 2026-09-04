/**
 * United States locality domain labels.
 *
 * A table of DNS labels published under `.us`, not a branch on any vertical.
 * They appear in two shapes, and getting them wrong collapses every public body
 * in a state onto one apparent site:
 *
 *   sample.k12.tx.us   label directly before the state
 *   ci.austin.tx.us    label before a place name
 *
 * `tests/neutral-core-guard.test.ts` exempts this one file by path, because a
 * registry's own label list is data rather than vertical-specific logic.
 */
export const US_LOCALITY_DOMAIN_LABELS: readonly string[] = [
  'k12',
  'co',
  'ci',
  'cc',
  'lib',
  'mus',
  'gen',
  'state',
  'town',
  'vil',
  'tec',
  'dst',
];
