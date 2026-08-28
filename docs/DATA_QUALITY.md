# Data quality

## Principles

**Never invent a value.** A field a source did not publish stays null. Parsing
that cannot be done confidently is flagged, not forced: `parsePersonName`
returns `lowConfidence: true` for a mononym rather than guessing a surname.

**Keep the source value.** `source_observations` holds the raw string next to
the normalized one, for every field of every record, on every page.

**Separate what was published from what was guessed.** Structurally, in
different tables. See `DATA_MODEL.md`.

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

## Known limitations

These are real and are not hidden by the code.

- **Non-person rows become person rows.** A directory row for "Front Office"
  with `office@district.org` is stored as a person whose address is classified
  `general_inbox`. The classification is right and the export excludes general
  inboxes by default, but the person row is wrong. Modelling organizational
  contacts separately is in `BACKLOG.md`.
- **Name parsing is heuristic.** "Garcia, Maria de la Cruz" yields first
  "Maria", middle "de la Cruz", last "Garcia", which follows the source's own
  comma convention but is not always what the person would say.
- **Titles outside the rule table become `other`** with confidence 0.2. Run
  `pnpm admin titles <STATE>` to see what the vocabulary is missing; that report
  exists so the gap is visible rather than silently absorbed.
- **The mailto fallback is low quality by design.** It attaches the nearest
  name-shaped text to an address. Review before relying on those records.
- **County and district matching is exact after normalization.** No fuzzy
  matching. An unmatched county surfaces as a count mismatch against
  `expectedCountyCount`.

## Checks that run automatically

- Adapter contract tests over every fixture, including determinism and
  record-key stability.
- Idempotency: the end-to-end test crawls the same fixtures twice and asserts
  zero new rows on the second pass.
- Enum synchronization between Postgres and TypeScript, so a vocabulary drift
  fails a test rather than an insert weeks later.
- Migration up and down against a real Postgres, plus a checksum guard that
  refuses to run when an applied migration has been edited.

## Checks a person should run

After any real crawl:

1. `pnpm admin coverage <STATE>` for the counts.
2. `pnpm admin failures` for errors grouped by kind. `unsupported_platform` and
   `blocked_by_source` mean different things and need different responses.
3. `pnpm admin sample <STATE>` for the lowest-confidence records, and open the
   `source_url` on a few. Provenance exists so this check is cheap.
4. `pnpm admin titles <STATE>` and extend the title rules where it is worth it.

## Empty results are a signal

A page that fetches cleanly and yields nobody is recorded as `empty_success`,
not silently as zero. It usually means the directory is JavaScript-rendered, the
adapter is wrong for the platform, or the page genuinely is empty. All three
need a person, and none of them should look like a successful crawl.
