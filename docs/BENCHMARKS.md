# Database benchmarks

## National ancestry and suppression query

Run on 2026-09-04 against the dedicated Supabase project on its smallest
Postgres compute tier. The synthetic dataset contained:

- 100,000 organizations in a balanced four-child hierarchy
- 99,999 active containment relationships
- 100,000 people, assignments and published work-email rows, one per organization
- one active suppression at the root of the organization tree

The acceptance budget was five seconds for the suppression scan and five
seconds for materializing the complete organization ancestry. Both measurements
used PostgreSQL `EXPLAIN ANALYZE`, after `ANALYZE` on the populated tables.

| Measurement                                  | Rows    | Time         | Budget   |
| -------------------------------------------- | ------- | ------------ | -------- |
| Complete ancestry result                     | 883,495 | 1,831.886 ms | 5,000 ms |
| Indexed subtree-suppression scan over people | 100,000 | 670.649 ms   | 5,000 ms |

The first suppression run exceeded the management gateway's roughly two-minute
window. It revealed two independent problems: `email_addresses.person_id` had no
index, and the correlated subtree predicate caused repeated scans of the global
ancestry CTE. Migration 0015 adds the missing index. `QueryRepository` now
walks outward only from active subtree suppressions and uses a hashed membership
subplan, while retaining the in-memory suppression re-check before export.

The synthetic rows were removed after the test and zero benchmark people,
organizations, relationships and source documents remained. The 20 audit-chain
concurrency events described in `BACKLOG.md` are intentionally retained because
audit evidence is append-only.
