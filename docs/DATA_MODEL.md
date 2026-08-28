# Data model

Institutions, people, employment and email addresses are modelled separately, so
one person can hold several assignments and several addresses without any of
them overwriting another.

## Tables

| Group                      | Tables                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| Provenance                 | `source_pages`, `source_observations`, `directory_platforms`                               |
| Geography and institutions | `states`, `counties`, `districts`, `schools`, `departments`                                |
| People                     | `people`, `employment_assignments`                                                         |
| Email                      | `email_addresses`, `email_candidates`, `email_validation_results`, `domain_email_patterns` |
| Crawling                   | `crawl_runs`, `crawl_targets`, `crawl_pages`, `crawl_errors`, `crawl_checkpoints`          |
| Compliance                 | `suppression_entries`, `complaints`, `exports`, `audit_events`                             |

## Provenance

Every material value is traceable. `source_observations` is append-only and
holds one row per field per record per page: the raw string, the normalized
value, the extraction method, the confidence and the selector it came from.
Normalized rows carry `source_page_id` (or `inference_evidence_id`), the crawl
run, the extraction method, the confidence and a first-seen/last-seen window.

`first_seen_at` only ever moves earlier and `last_seen_at` only ever moves
later, so "still on the source" and "first found today" stay distinguishable
after any number of recrawls.

The constraint `<table>_has_provenance` on `districts`, `schools`, `people`,
`employment_assignments` and `email_addresses` makes a row without evidence
impossible to insert.

## Identity and deduplication

Two different keys, for two different jobs:

- **`recordKey`** is derived from (adapter, source URL, local key). It is stable
  for the same row on the same page, which is what makes recrawling one page
  idempotent. It is deliberately useless for cross-page identity.
- **`identity_key`** on `people` is (state, organization, normalized last +
  first name). Middle names are excluded, because "Jane Smith" and "Jane M.
  Smith" are one person and treating them as two is the largest source of
  duplicates in directory data. Scoping to an organization keeps two people who
  share a name in different districts apart.

`PersonResolver` prefers a published email over the identity key, because two
"J. Smith" rows sharing an address are certainly the same person.

## Email classes

Six classes, and the boundary between observed and inferred is structural.

| Class                | Meaning                                                 | Stored in          |
| -------------------- | ------------------------------------------------------- | ------------------ |
| `published`          | Displayed in plain text by an official public source    | `email_addresses`  |
| `decoded_published`  | Publicly displayed, recovered from basic obfuscation    | `email_addresses`  |
| `general_inbox`      | A school, office or department inbox, not one person    | `email_addresses`  |
| `invalid`            | Fails syntax, or a provider returned undeliverable      | `email_addresses`  |
| `inferred_candidate` | Generated from a domain pattern, never observed         | `email_candidates` |
| `suppressed`         | An overlay computed at query time, never a stored class | neither            |

`email_addresses_observed_only` is a CHECK constraint that makes it impossible
to store an inferred address alongside published ones. That is what "never
overwrite a published email with an inferred value" means here: not a rule the
application follows, a row shape that does not exist.

On re-observation, a stored `decoded_published` may be upgraded to `published`
when a later page shows the address in plain text. Nothing ever moves the other
way.

### Inference

`email_candidates` stores the pattern used, the supporting published examples
from the same domain, the support and conflict counts, the consistency, and a
`confidence` column that is separate from `validation_status`. Confidence
describes the strength of the evidence for the pattern. It is never a
deliverability claim.

`email_candidates_promotion_requires_validation` is a CHECK constraint: a
candidate can only be `promoted` when `validation_status = 'valid'` and
`promoted_at` is set. `accept_all` does not qualify, because a catch-all domain
tells you about the domain, not the mailbox.

## Suppression

`suppression_entries` supports exact email, domain (including subdomains),
person, school, district, state and global scopes, each with a reason, a source,
an effective date and an optional expiry. Rows are immutable: a trigger rejects
any update other than revocation, and rejects deletes outright.

Enforcement is in the data layer. `QueryRepository.queryExportableRows` applies
suppression in SQL, so a consumer that forgets to check still cannot read a
suppressed person out of the database. The export path then re-checks in memory
immediately before writing, so an opt-out recorded between the query and the
write still takes effect, and a record that appeared in an older export gets no
grandfathering.

## Audit

`audit_events` is append-only by trigger, and each row's hash covers the
previous row's hash. Altering or removing an event breaks every event after it,
which `ComplianceRepository.verifyAuditChain` detects.

## Required output fields

The CSV export carries: first name, middle name, last name, full published
name, title, normalized title, role category, department, school, district,
county, state, published email, inferred email candidate, email classification,
email validation status, inference confidence, source URL, source type, first
seen, last seen, crawl run, extraction method, confidence, and active/inactive
status. Published and inferred addresses are separate columns and are never
merged.
