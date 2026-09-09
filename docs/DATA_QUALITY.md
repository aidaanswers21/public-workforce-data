# Data quality

## Principles

**Never invent a value.** A field a source did not publish stays null. Parsing
that cannot be done confidently is flagged, not forced: `parsePersonName`
returns `lowConfidence: true` for a mononym rather than guessing a surname.

**Keep the source value.** `source_observations` holds the raw string next to
the normalized one, for every field of every record, on every document.

**Separate what was published from what was guessed.** Structurally, in
different tables. See `DATA_MODEL.md`.

**Never treat a normalization as truth.** The published title is preserved
untouched, and every normalization records how it was produced.

## HTML field boundaries and rejected addresses

Generic HTML email extraction separates neighboring elements before decoding addresses.
This prevents a department label or phone number from being joined onto an address
when the page has no whitespace between tags. Explicit mailto and email attributes
remain evidence sources. Split inline formatting that cannot be decoded confidently
may yield no address; the parser does not guess a missing local part.

Both the preferred export email and the complete email list require active,
published or decoded-published addresses associated with the assignment's organization
(or no organization). General inboxes require the corresponding export option.
Invalid or inactive addresses are excluded, and source and address suppressions
apply to both fields. When an extraction defect is confirmed, deactivate the bad
parsed address and classify it as invalid, append an audit event, and preserve
its original source observations and document evidence.

## Normalization provenance

`normalizeTitle` runs against a rule set composed from the neutral base plus
every registered sector pack. Each assignment records:

| Column                      | Meaning                                                  |
| --------------------------- | -------------------------------------------------------- |
| `title_published`           | Exactly what the source displayed, never rewritten       |
| `title_normalized`          | The normalized form                                      |
| `normalization_method`      | `rule_table`, `exact_match`, `manual`, `assisted_review` |
| `normalization_rule_source` | Which pack contributed the rule that matched             |
| `taxonomy_version`          | Hashed from the rule content itself                      |
| `normalization_confidence`  | How strong the match was                                 |

`taxonomy_version` is derived from the rules rather than hand-maintained, so
editing a rule changes the version automatically. A record produced under an
older version is comparable against a newer one, and a re-normalization is a
measurable change rather than a silent one.

A title nothing matched becomes the fallback category at low confidence rather
than being dropped. `pnpm admin titles` lists them, which is how the taxonomy
grows from evidence instead of guesswork.

## Confidence

Confidence is on a 0..1 scale and means "how sure are we that this record is
what we think it is", set by the adapter and carried through to the export.

| Source                                          | Confidence |
| ----------------------------------------------- | ---------- |
| JSON-LD or microdata                            | 0.95       |
| JSON API                                        | 0.92       |
| Table with a person column and a contact column | 0.90       |
| Card or list group with a contact               | 0.80       |
| Card or list group with a title only            | 0.60       |
| Definition list                                 | 0.70       |
| Mailto harvesting fallback                      | 0.45       |

Inference confidence is separate and never a deliverability claim:
`consistency * (0.75 + 0.25 * min(1, support/20))`, capped at 0.95.

Normalization confidence is separate again, and describes the title match only.

## Known limitations

These are real and are not hidden by the code.

- **Non-person rows become person rows.** A directory row for "Front Office"
  with `office@city.example.gov` is stored as a person whose address is
  classified `general_inbox`. The classification is right and the export
  excludes general inboxes by default, but the person row is wrong. Modelling
  organizational contacts separately is in `BACKLOG.md`. `isOrganizationLabel`
  catches the common cases using the composed vocabulary, so a row like that no
  longer vouches for `office@` as a personal address, but the row still exists.
- **Name parsing is heuristic.** "Garcia, Maria de la Cruz" yields first
  "Maria", middle "de la Cruz", last "Garcia", which follows the source's own
  comma convention but is not always what the person would say. Trailing
  suffixes are pulled out first, so "SMITH, ROBERT JR." does not put "Jr." in
  the middle name.
- **Titles outside the composed rule table become the fallback** at low
  confidence. Run `pnpm admin titles` to see what the vocabulary is missing;
  that report exists so the gap is visible rather than silently absorbed.
- **An over-broad rule can still shadow another rule inside its own scope.**
  Cross-vertical leakage is now structurally impossible, because a pack's rules
  are only consulted for organizations its scope covers. What scoping does not
  prevent is a rule being too broad within its own vertical: a bare `counselor`
  rule in the education pack claimed a county's Veterans Counselor before
  scoping, and would still claim a district's if the district employed one.
  `tests/title-taxonomy.test.ts` asserts nine specific titles for that reason.
- **The mailto fallback is low quality by design.** It attaches the nearest
  name-shaped text to an address. Review before relying on those records.
- **Geographic area matching is exact after normalization.** No fuzzy matching.
  An unmatched area surfaces as a count mismatch against `expectedAreaCount`.
- **An organization with no identifier, no parent and no domain enters review.**
  It is stored, it is stable across recrawls, and it is listed by
  `identityReviewQueue()`. It is neither merged into a look-alike nor
  duplicated, but nothing resolves it automatically either.
- **Organizational unit resolution is shallow.** A published department string
  resolves to an `organizational_units` row by normalized name. Sub-units and
  renames are not reconciled.

## Checks that run automatically

- Adapter contract tests over every fixture, including determinism and
  record-key stability.
- Idempotency: the end-to-end test crawls the same fixtures twice and asserts
  zero new rows on the second pass.
- Subtree suppression, asserted both in SQL and in memory, because implementing
  it once in two places is exactly where a silent divergence would live.
- The neutral core guard, which reads every neutral source file and fails on
  education terms, platform vendors, state names and forbidden imports.
- Composed title taxonomy resolutions across all three sector packs.
- Enum synchronization between Postgres and TypeScript, so a vocabulary drift
  fails a test rather than an insert weeks later.
- Reference data synchronization between the taxonomy and the seeded tables.
- Migration up and down against a real Postgres, plus a checksum guard that
  refuses to run when an applied migration has been edited.
- Type checking of the test suite itself, so a fixture that drifts from an
  interface fails the gate rather than a test run.
- Sector pack collision detection, so two packs defining the same code fail at
  start-up instead of resolving by argument order.
- Cross-sector title resolution on nine deliberately ambiguous titles.
- Identifier-less recrawl idempotency, and same-named organizations under
  different parents staying separate.
- Append-only evidence: a changed content hash appends a version and the earlier
  observation stays readable.
- Monotonic suppression revocation, attempted through raw SQL.
- Row level security enabled and forced on every table, with no policies.
- The data boundary asserted through the real pipeline: a poisoned record leaves
  nothing behind in any of seven columns it could have reached.

## Checks a person should run

After any real crawl:

1. `pnpm admin coverage` for the counts, scoped to a level or a sector.
2. `pnpm admin failures` for errors grouped by kind. `unsupported_platform`,
   `policy_hold` and `blocked_by_source` mean different things and need
   different responses.
3. `pnpm admin policies` for sources still awaiting review or approval.
4. `pnpm admin sample` for the lowest-confidence records, and open the
   `source_url` on a few. Provenance exists so this check is cheap.
5. `pnpm admin titles` and extend the sector's title rules where it is worth it.

## Empty results are a signal

A page that fetches cleanly and yields nobody is recorded as `empty_success`,
not silently as zero. It usually means the directory is JavaScript-rendered, the
adapter is wrong for the platform, the sector vocabulary is missing this site's
wording, or the page genuinely is empty. All four need a person, and none of
them should look like a successful crawl.
