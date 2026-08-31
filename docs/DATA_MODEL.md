# Data model

Forty-three tables. Organizations, relationships, people, employment and contact are
modelled separately, so one person can hold several assignments and several
addresses without any of them overwriting another, and so an organization can
move under a new parent without its history being rewritten.

## Reference data, not enums

Two different mechanisms, chosen on whether the set will grow.

**Postgres enums** hold genuinely closed sets: record status, email
classification, validation status, collection status, policy stance,
normalization method, assignment status, organization identity tier, complaint
channel, complaint resolution, suppression scope, suppression source, crawl stop
reason, error kind, export status. Adding a value here is a deliberate schema
change because the code branches on every one of them.

**Controlled reference tables** hold everything that grows as sectors and
jurisdictions are added: `government_levels`, `sectors`, `organization_types`,
`relationship_types`, `geographic_area_types`, `identifier_systems`,
`source_types`, `evidence_classes`, `job_families`, `role_categories`,
`seniority_levels`, `contact_point_types`, `extraction_methods`,
`obfuscation_kinds`. Each has a stable `code` primary key and is seeded from
`@public-workforce/taxonomy` by `seedReferenceData`.

`extraction_methods` and `obfuscation_kinds` were enums and are not any more.
Both grow every time the platform meets a source format or an anti-harvesting
trick it has not met before, and requiring a migration to record that a value
came out of a PDF table is how such a value ends up recorded as `manual`
instead.

Adding a school type, a role category or an identifier system therefore needs no
migration. That is the point: a platform that requires a schema change every
time a new kind of public body appears will stop being extended.

## Tables

| Group                | Tables                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference (0001)     | `government_levels`, `sectors`, `organization_types`, `relationship_types`, `geographic_area_types`, `identifier_systems`, `source_types`, `evidence_classes`, `job_families`, `role_categories`, `seniority_levels`, `contact_point_types` |
| Provenance (0002)    | `crawl_runs`, `source_policies`, `directory_platforms`, `source_documents`, `source_observations`                                                                                                                                           |
| Geography (0003)     | `geographic_areas`, `jurisdictions`                                                                                                                                                                                                         |
| Organizations (0004) | `organizations`, `organization_relationships`, `organizational_units`, `organization_locations`, `external_identifiers`                                                                                                                     |
| People (0005)        | `people`, `employment_assignments`, `contact_points`                                                                                                                                                                                        |
| Email (0006)         | `email_addresses`, `email_candidates`, `email_validation_results`, `domain_email_patterns`                                                                                                                                                  |
| Crawling (0007)      | `crawl_targets`, `crawl_pages`, `crawl_errors`, `crawl_checkpoints`                                                                                                                                                                         |
| Compliance (0008)    | `suppression_entries`, `complaints`, `exports`, `audit_events`                                                                                                                                                                              |
| Extensions (0009)    | `education_organization_attributes`                                                                                                                                                                                                         |

## Organizations

`organizations` is neutral. It carries a name, a normalized name, a government
level code, a sector code, an organization type code, an optional jurisdiction,
a website, an identity fingerprint and provenance. It has **no parent column**.
See `ORGANIZATION_HIERARCHY.md` for why, and for how ancestry is queried.

### Level and sector are orthogonal

What kind of body an organization is, what level of government it belongs to,
and what work it does are three separate facts, and the source decides all
three.

An independent school district is a `school_district` at the `special_district`
level in the `education` sector. A city-run one is the same type at the
`municipal` level in the same sector. A state education agency is a
`state_education_agency` at the `state` level in the `education` sector.

`organization_types.default_government_level_code` and `default_sector_code` are
**defaults for onboarding**, both nullable, and neither constrains a row. There
is deliberately no composite foreign key from an organization to a
(type, level, sector) triple: such a key would force every school, and every
public authority, into one level and one sector for good.

There is no `education` government level. Education is a sector; making it a
level would put a sector into a list that is not about sectors, and would force
every education organization to claim a level it does not factually have.

### Identity

`identity_fingerprint` is unique, and `resolveIdentity` computes it from the
strongest evidence available:

| Tier                  | Key                                                |
| --------------------- | -------------------------------------------------- |
| `official_identifier` | The issuing system and the value                   |
| `source_identifier`   | A stable key the source itself assigns             |
| `parent_scoped_name`  | Jurisdiction, parent, type and normalized name     |
| `domain_scoped_name`  | Jurisdiction, domain, type and normalized name     |
| `ambiguous`           | The source record itself, and flagged for a person |

The parent is part of the key at tier 3, and that is the whole point of the
tier: two "Lincoln Elementary" schools in two districts are two schools, and a
key of type plus name plus jurisdiction alone would merge them. The same applies
to two Parks and Recreation departments in two municipalities.

Because the fingerprint is deterministic and unique, an identifier-less recrawl
of the same source record resolves to the same organization rather than adding
another. An ambiguous record is kept, keyed on the source document so it is
still idempotent, and listed by
`OrganizationRepository.identityReviewQueue()` for a person to confirm. It is
never merged into a look-alike and never silently duplicated.

Related tables:

- `organization_relationships` places an organization under another, with a
  relationship type and an effective-dated window.
- `organizational_units` holds departments, divisions, bureaus and offices
  inside an organization.
- `organization_locations` holds professional office addresses.
- `external_identifiers` holds official identifiers, one row per identifier
  system, so an organization can carry a state identifier and a federal one at
  once without a column per scheme.
- `education_organization_attributes` holds grade span, campus type and similar
  facts, guarded by a trigger to education-sector organizations only.

## Jurisdiction and location

`jurisdictions` is who governs. `geographic_areas` is where a place is. An
organization's jurisdiction and an employee's duty location are separate facts
that often disagree, and the model keeps them apart on purpose. See
`JURISDICTION_VS_DUTY_LOCATION.md`.

A federal organization has no state above it in either dimension: no state
jurisdiction is required, and no state parent is invented. `us-federal` is a
jurisdiction at the `federal` government level, not a state.

## People and employment

`people` holds identity only: name parts, the published full name, an identity
key and provenance. **Title and department are not on the person.** They live on
`employment_assignments`, alongside the organization, the organizational unit,
the role category, the job family, the seniority, the assignment status and the
dates. A person with three simultaneous assignments has three rows, and none of
them overwrites another.

`contact_points` holds work phone numbers, office addresses and similar
professional contact details, typed by `contact_point_types`.

### Title normalization is recorded, not assumed

`title_published` is the exact string the source displayed and is never
rewritten. Beside it, the assignment records:

- `title_normalized`, the normalized form;
- `normalization_method`, one of `rule_table`, `exact_match`, `manual`,
  `assisted_review`;
- `normalization_rule_source`, which pack contributed the rule that matched;
- `taxonomy_version`, hashed from the rule content itself, so changing a rule
  changes the version and a re-run is comparable against the old one;
- `normalization_confidence`;
- `role_category_code`, `job_family_code`, `seniority_code`, `specialty`.

A normalization nothing matched becomes the fallback category at low confidence
rather than being dropped, so `pnpm admin titles` can show what the taxonomy is
missing. No normalization is treated as truth: the published string is always
there to check it against.

## Provenance

Every material value is traceable.

`source_documents` is the stable identity of a source: a URL, a dataset, a
spreadsheet. `source_document_versions` is what that source said, once, and is
immutable. A new content hash appends a version; identical content matches the
existing one and only moves `last_seen_at`, which is what makes a recrawl
idempotent without making it forgetful. What a page said in March is still
readable after it changes in June.

`source_observations` is append-only and holds one row per field per record per
**document version**: the raw string, the normalized value, the extraction
method, the confidence, the selector it came from, and an **evidence class**.
Keying on the version rather than the URL is what lets a page change its mind
about someone's title and produce a second observation beside the first, rather
than overwriting it.

The evidence classes are `organization`, `employment`, `contact`, `location` and
`policy`. Employment evidence and contact evidence are separate rows, because
"this page said she is the deputy director" and "this page said her office
number is 555-0100" are different claims that can be true at different times and
be superseded independently.

Normalized rows carry `source_document_id`, the crawl run, the extraction
method, the confidence and a first-seen/last-seen window. There is no
`inference_evidence_id`: it existed as a nullable column that any UUID would
satisfy, backed by no inference-evidence model, so a row could claim provenance
that pointed at nothing. Inferred addresses live in `email_candidates` with
their own evidence columns, which is where inference belongs. `first_seen_at` only ever moves earlier and `last_seen_at` only ever
moves later, so "still on the source" and "first found today" stay
distinguishable after any number of recrawls.

Provenance is a **NOT NULL foreign key** to `source_documents` with
`on delete restrict`, plus a named `<table>_has_provenance` CHECK, on
`organizations`, `organization_relationships`, `organizational_units`,
`organization_locations`, `external_identifiers`, `people`,
`employment_assignments`, `contact_points`, `email_addresses` and
`education_organization_attributes`. A row without evidence cannot be inserted,
and a document something still cites cannot be deleted.

`organizational_units` was the one provenance-bearing table missing its
constraint while the column was nullable. It has one now, and a negative test.

## Source policy

`source_policies` records, per domain or URL pattern, a collection status
(`permitted`, `prohibited`, `review_required`, `unknown`), the policy stance
observed, who reviewed it and when, and who approved production collection. The
constraint `source_policies_prohibited_not_approved` makes a prohibited row that
is also approved impossible to store. See `SOURCE_POLICY_REVIEW.md`.

## Identity and deduplication

Two different keys, for two different jobs:

- **`recordKey`** is derived from (adapter, source URL, local key). It is stable
  for the same row on the same page, which is what makes recrawling one page
  idempotent. It is deliberately useless for cross-page identity.
- **`identity_key`** on `people` is (organization, normalized last + first name).
  Middle names are excluded, because "Jane Smith" and "Jane M. Smith" are one
  person and treating them as two is the largest source of duplicates in
  directory data. Scoping to an organization keeps two people who share a name
  at different public bodies apart.

`PersonResolver` prefers a published email over the identity key, because two
"J. Smith" rows sharing an address are certainly the same person.

## Email classes

Six classes, and the boundary between observed and inferred is structural.

| Class                | Meaning                                                 | Stored in          |
| -------------------- | ------------------------------------------------------- | ------------------ |
| `published`          | Displayed in plain text by an official public source    | `email_addresses`  |
| `decoded_published`  | Publicly displayed, recovered from basic obfuscation    | `email_addresses`  |
| `general_inbox`      | An office, department or shared inbox, not one person   | `email_addresses`  |
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

A personal-domain address is not stored at all. The data boundary drops it
during ingestion and counts the drop, because a public employee's personal
mailbox is out of scope even when a directory publishes it.

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

`suppression_entries` supports eleven scopes:

| Scope                  | Withholds                                                     |
| ---------------------- | ------------------------------------------------------------- |
| `person`               | One person                                                    |
| `email`                | One exact address                                             |
| `domain`               | A domain and its subdomains                                   |
| `organization`         | Everyone at one organization                                  |
| `organization_subtree` | Everyone at an organization and every organization beneath it |
| `source`               | Everything derived from one source policy                     |
| `jurisdiction`         | Everyone under one jurisdiction                               |
| `government_level`     | Everyone at one level of government                           |
| `geographic_area`      | Everyone whose duty location falls in one area                |
| `export_purpose`       | A named export purpose                                        |
| `global`               | Everyone                                                      |

`geographic_area` matches the areas listed on a row and does **not** walk up the
area tree today, so suppressing a state does not suppress the counties inside
it. That is a limitation, not a design: it is tracked as production blocker C15
in `BACKLOG.md` and it blocks an outreach export.

Each carries a reason, a source, an effective date and an optional expiry. Rows
are immutable: a trigger rejects any update other than revocation, and rejects
deletes outright. Every foreign key is `on delete restrict`, never cascade: a
cascade would delete an opt-out because the thing it names was deleted, which is
the one outcome suppression exists to prevent.

### Revocation is monotonic

`revoked_at` may go from null to a timestamp exactly once. It can never return
to null, and it can never be moved to a different time. `revoked_reason` must be
supplied with the revocation and is immutable afterwards. A trigger enforces all
of it, so raw SQL cannot undo or rewrite a revocation either.

Revocation writes an `audit_events` row through `audit_event_append`, the one
canonical appender the repository also uses, so a revocation made outside the
application still lands in the hash chain and the chain cannot fork.

Enforcement is in the data layer. `QueryRepository.queryExportableRows` applies
suppression in SQL, using a recursive CTE for the subtree scope, so a consumer
that forgets to check still cannot read a suppressed person out of the database.
The export path then re-checks in memory, using `OrganizationHierarchy` for the
same subtree rule, immediately before writing. An opt-out recorded between the
query and the write still takes effect, and a record that appeared in an older
export gets no grandfathering.

Both passes are tested against each other in
`tests/extensibility.test.ts` construction 8 and in the end-to-end suite, because
getting only one of them right is the likeliest silent failure in the system.

## Audit

`audit_events` is append-only by trigger, and each row's hash covers the
previous row's hash. Altering or removing an event breaks every event after it,
which `ComplianceRepository.verifyAuditChain` detects.

## Required output fields

A row is evaluated in three independent decisions: the record itself, its
published address, and its inferred candidate. A suppressed published address
withholds the row, because exporting a guess at the same mailbox would be an
obvious way around the request. A suppressed candidate blanks that one column
and keeps the row, unless the candidate was the row's only address.

Candidates in the `rejected` and `suppressed` states never reach an export at
all: the SQL excludes both before the in-memory re-check ever sees them.

The CSV export carries 33 columns: first name, middle name, last name, full
published name, title, normalized title, role category, job family, seniority,
department, organization, organization type, parent organization, government
level, sector, jurisdiction, duty location city, duty location county, duty
location state, published email, inferred email candidate, email classification,
email validation status, inference confidence, source URL, source type, first
seen, last seen, crawl run, extraction method, confidence, assignment status,
record status.

Published and inferred addresses are separate columns and are never merged.
