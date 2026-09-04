# Working in this repository

Read this before changing anything. `docs/` has the detail; this file is the
short version of what must stay true.

## What this system is for

It collects publicly displayed U.S. public-sector organization and employee
directory data across six levels of government, normalizes it, and stores it
with provenance. It does not send outreach. If you find yourself adding a mail
transport, a send queue or an outreach API, stop: that belongs in a different
system.

## Governance

### Who decides

| Role                    | Who                  | What they may do                                    |
| ----------------------- | -------------------- | --------------------------------------------------- |
| Human owner             | The repository owner | The only source of approval for anything below      |
| Architectural authority | Fable                | Rules on architecture and reviews designs. Advisory |
| Implementation owner    | Opus                 | Writes the code and reports what it did. Advisory   |
| Independent reviewer    | Codex                | Reviews independently of the implementer. Advisory  |

**No model may grant approval, to itself or to another model.** A Fable verdict
of GREEN and a Codex verdict of "approved" are opinions for the human owner to
weigh. Neither is permission. Two models agreeing is still no human.

**Credentials never imply authorization.** Holding a push token, a database URL
or a cloud key means the action is technically possible. It says nothing about
whether it is permitted. If an action below needs approval, having the means to
perform it changes nothing.

**No inferred standing authorization.** Approval is specific and it expires with
the task it was given for. Approval to push once is not approval to push again.
Approval to run a fixture crawl is not approval to run a live one. Approval for
one repository, branch, or environment does not extend to another. When in
doubt, the answer is that you do not have it.

### Actions that require explicit human approval

Every one of these, every time:

- **Commit** to any branch.
- **Push** to any remote.
- **Open a pull request.**
- **Merge** a pull request, or any branch into any other branch.
- **Deploy** to any environment.
- **Apply a migration** to any database that is not a local test harness.
- **Run a live crawl**, or any request to a real source.
- **Purchase** anything, or enable a billable provider.
- **Change access**: credentials, permissions, repository settings, branch
  protection.

Approval is a person saying so in words. A test passing is not approval. A green
review is not approval. A task description that mentions a step is not approval
to take it.

### What may be done without asking

Reading, analysing, writing code in the working tree, running the local test
suite, running the fixture crawl, and reporting what happened. If it does not
leave the working tree and does not touch a real source, it is ordinary work.

### Reporting

Report what was actually run and what it actually said. If something is
untested, unverified or partly done, say so plainly. Do not describe an intended
outcome as an achieved one, and do not summarize a failing run as a passing one.

**Documentation must be updated with behavioral changes, in the same change.**
A document that describes behaviour the code does not have is worse than no
document: it is a claim a reader will rely on. If a change makes a document
wrong, the change is not finished until the document is right.

### Verification requirements

Before reporting a change complete:

```bash
node --version        # 22
pnpm install --frozen-lockfile
pnpm verify           # format, lint, typecheck (sources and tests), test, build
pnpm crawl:fixture    # the pipeline end to end
```

A change to the schema also runs migrations up, down and up again. A change to
the neutral core also runs the guard test. Report the counts you actually saw.

## Rules that are not negotiable

1. **Never invent a value.** A field a source did not publish stays null. If a
   parse is uncertain, flag it (`lowConfidence`) rather than guessing. This
   applies to documentation and configuration too: an official source URL nobody
   has opened is `verified: false`.
2. **Stay inside the public professional data boundary.** Collect only what a
   public source published about someone's public role: name, title,
   department, organization, work location, public work phone, public work
   email. Never student information, government identification numbers, dates of
   birth, personal financial or medical information, home addresses, family
   information, personal email addresses, or anything behind authentication.
   `applyDataBoundary` in `@public-workforce/core` enforces this on every ingested record.
3. **Never evade an access control.** No authentication, no CAPTCHA bypass, no
   retry-harder against a 403. A blocked source is recorded as blocked.
4. **Never collect from an unapproved source in production.** `prohibited` is
   absolute and no approval overrides it. `review_required` and `unknown` block
   until a person records an approval on the policy row. A vendor's assurance
   that data is compliant changes nothing.
5. **Never let an inferred address look published.** They live in different
   tables, and a CHECK constraint enforces it. Do not relax that constraint.
6. **Never bypass suppression.** It is applied in SQL and re-checked in memory
   immediately before an export is written. Both passes stay.
7. **Never commit a secret.** `.env.example` names variables and holds no
   values. Record what is connected, never the credential.
8. **Never treat a normalization as truth.** The published value is preserved
   and the normalization records its method, rule source, version and
   confidence beside it.
9. **Nothing above the Governance section is waived by approval.** Approval
   permits an action; it does not permit collecting a prohibited field or
   bypassing suppression.

## The neutrality rule

`packages/core`, `packages/shared-types`, `packages/taxonomy`,
`packages/database`, `packages/extraction`, the adapter packages, the
jurisdiction kit, the ingestion pipeline, the workers and the apps are
**neutral**. They may not name a school, a state, a directory platform or any
other single vertical, and they may not branch on one.

Vertical knowledge lives in exactly four places: a sector pack
(`packages/sectors/<sector>/`), a jurisdiction configuration
(`packages/jurisdiction-config/<key>/`), a directory adapter
(`packages/directory-adapters/<platform>/`), or a fixture.

`tests/neutral-core-guard.test.ts` enforces this by reading the source. It
strips comments first, so documentation examples are allowed and executable code
is not. Two files are exempt by exact path. The taxonomy domain table is
registry data, and the data-boundary module must name the protected fields it
rejects. The test constrains both exemptions so neither can hide vertical logic.

## Conventions

- TypeScript strict, ESM, `NodeNext`. Relative imports end in `.js`.
- Comments explain _why_, not _what_. Do not narrate the code.
- No em dashes in prose or comments.
- Every material value carries provenance, and provenance is a NOT NULL foreign
  key to `source_documents` with `on delete restrict`, plus a named
  `<table>_has_provenance` CHECK. A nullable column with a CHECK any UUID would
  satisfy is not provenance.
- Evidence is append-only. A changed page appends a `source_document_versions`
  row and observations reference the version, never the URL alone.
- A closed set that will never grow is a Postgres enum. A set that grows as
  sectors, jurisdictions or source formats are added is controlled reference
  data with a stable `code` primary key, seeded from the taxonomy. Adding an
  organization type, a role category, an extraction method or an obfuscation
  kind must never require a migration.
- Government level and sector are orthogonal, independently recorded attributes
  of an organization. An organization type may suggest defaults for both and
  constrains neither. There is no `education` government level.
- Sector packs may not silently redefine a code the base or another pack
  defines. A collision is a start-up error unless the pack lists the code in
  `overrides`.
- A pack's title rules and vocabulary apply only inside its declared
  `appliesTo` scope. The neutral base always applies.
- Every enum value exists in both `packages/shared-types/src/enums.ts` and a
  Postgres enum. `packages/database/src/schema.test.ts` fails if they drift.
- Every migration has a down script. Never edit an applied migration; the runner
  refuses to run when a checksum changes. Add a new one.
- Tests use saved fixtures. Nothing in the test suite may touch the network.

## Where things go

| Change                                           | Where                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| A new directory platform                         | `packages/directory-adapters/<platform>/` plus one `register` call |
| A new sector's org types, roles, titles, wording | `packages/sectors/<sector>/`                                       |
| A new jurisdiction at any level of government    | `packages/jurisdiction-config/<key>/` plus one `register` call     |
| Normalization, email logic, suppression, export  | `packages/core`                                                    |
| Crawl budgets, robots, guards, checkpointing     | `packages/core/src/crawl`                                          |
| Source policy and the data boundary              | `packages/core/src/policy`                                         |
| Schema                                           | `supabase/migrations`, with a down script                          |
| Anything vertical-specific                       | Never in a neutral package                                         |

`tests/extensibility.test.ts` asserts the last row. It builds ten public-sector
constructions inside the test file, from a school under a district to a federal
worker with a duty location and no state above them, and runs every one through
unmodified neutral core.

## Before you say it works

See **Verification requirements** under Governance above. Report what you
actually ran and what it said. If something is untested or unverified, say so
plainly rather than implying otherwise.
