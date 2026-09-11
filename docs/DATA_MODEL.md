# Data model

Forty-eight domain tables, plus `schema_migrations` in the local migration
harness. Organizations, relationships, people, employment and contact are
modelled separately, so one person can hold several assignments and several
addresses without any of them overwriting another, and so an organization can
move under a new parent without its history being rewritten.

## Reference data, not enums

Two different mechanisms, chosen on whether the set will grow.

**Postgres enums** hold genuinely closed sets: record status, email
classification, validation status, collection status, policy stance,
normalization method, assignment status, organization identity tier, complaint
channel, complaint resolution, suppression scope, suppression source, crawl stop
reason, error kind, export status, and collection project, batch, and job
lifecycles. Adding a value here is a deliberate schema
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

| Group                      | Tables                                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference (0001)           | `government_levels`, `sectors`, `organization_types`, `relationship_types`, `geographic_area_types`, `identifier_systems`, `source_types`, `evidence_classes`, `job_families`, `role_categories`, `seniority_levels`, `contact_point_types`, `extraction_methods`, `obfuscation_kinds` |
| Provenance (0002)          | `crawl_runs`, `source_policies`, `directory_platforms`, `source_documents`, `source_document_versions`, `source_observations`                                                                                                                                                          |
| Geography (0003)           | `geographic_areas`, `jurisdictions`                                                                                                                                                                                                                                                    |
| Organizations (0004, 0016) | `organizations`, `organization_relationships`, `organizational_units`, `organization_locations`, `external_identifiers`, `organization_website_candidates`                                                                                                                             |
| People (0005)              | `people`, `employment_assignments`, `contact_points`                                                                                                                                                                                                                                   |
| Email (0006)               | `email_addresses`, `email_candidates`, `email_validation_results`, `domain_email_patterns`                                                                                                                                                                                             |
| Crawling (0007)            | `crawl_targets`, `crawl_pages`, `crawl_errors`, `crawl_checkpoints`                                                                                                                                                                                                                    |
| Compliance (0008)          | `suppression_entries`, `complaints`, `exports`, `audit_events`                                                                                                                                                                                                                         |
| Extensions (0009)          | `education_organization_attributes`                                                                                                                                                                                                                                                    |
| Corrections (0011)         | `organization_identity_evidence`                                                                                                                                                                                                                                                       |

## Organizations

`organizations` is neutral. It carries a name, a normalized name, a government
level code, a sector code, an organization type code, an optional jurisdiction,
a website, an identity fingerprint and provenance. It has **no parent column**.

A website published by a source may populate the organization row. A URL found
through a registry, directory or search result first enters
`organization_website_candidates` with its source version, method, match signals
and confidence. It becomes canonical only through a recorded verification.
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

| Tier                  | Key                                                          |
| --------------------- | ------------------------------------------------------------ |
| `official_identifier` | The issuing system, issuing state when applicable, and value |
| `source_identifier`   | A stable key the source itself assigns                       |
| `parent_scoped_name`  | Jurisdiction, parent, type and normalized name               |
| `domain_scoped_name`  | Jurisdiction, domain, type and normalized name               |
| `ambiguous`           | The source record itself, and flagged for a person           |

The parent is part of the key at tier 3, and that is the whole point of the
tier: two "Lincoln Elementary" schools in two districts are two schools, and a
key of type plus name plus jurisdiction alone would merge them. The same applies
to two Parks and Recreation departments in two municipalities.

The repository reconciles official identifiers, source-local identifiers and
exact prior scoped fingerprints inside one transaction. It never falls back to
type, name and jurisdiction alone: that would erase the parent or domain that
keeps look-alike organizations separate. Stronger evidence upgrades the
canonical fingerprint regardless of arrival order. Every observed official
identifier, source-local identifier, tier fingerprint, name and source URL is
retained in `organization_identity_evidence`, so a rename or stronger later
source does not discard the earlier identity evidence. A weaker later
observation can refresh last-seen and evidence history, but cannot replace the
canonical fields or their provenance pointer.

An identifier-less recrawl with an exact retained parent- or domain-scoped
fingerprint therefore resolves to the same organization rather than adding
another. Conflicting identity evidence fails explicitly instead of silently
merging. An ambiguous record is kept, keyed on the source document so it is still
idempotent, and listed by
`OrganizationRepository.identityReviewQueue()` for a person to confirm. It is
never merged into a look-alike and never silently duplicated.

State-issued identifiers are unique within their issuing state. Both
`identity_fingerprint` and the `external_identifiers` uniqueness constraint
therefore include `issuing_state_code` when it is present. A Texas identifier
and a Colorado identifier with the same published value remain separate, while
global identifier systems such as NCES retain their system-and-value identity.

## Collection control plane

`collection_projects` stores an operator's jurisdiction configuration, sector
and government-level scope, optional organization filters, and finite page,
target, and error ceilings. An absent organization estimate is stored as null;
the selected organization count is an actual query result, never an invented
estimate.

The operator console reads government levels, sectors and organization types
from the same controlled taxonomy that seeds these tables. It does not maintain
a second list of codes in UI code. Jurisdiction and location choices come from
registered configurations and imported geographic facts, so an unavailable
scope is shown as not configured rather than being made to look runnable.

The project filter document also records whether the operator wants a worker to
finish an approved batch or stop after a smaller local job count. Finishing a
batch means draining that batch's known targets. It does not remove page, error,
retry, policy, robots or domain controls, and it never carries approval into a
later batch.

`collection_project_organizations` is the reviewable membership snapshot.
`collection_batches` records one finite release, including the approving human,
time, and approval note. Approval belongs to that batch and does not become
standing permission for another. `collection_jobs` gives each target durable
queue state, an expiring lease, attempts, its crawl run and observed counts.
Only an active project with an approved batch is claimable. A partial unique
index prevents two workers from holding active jobs for the same registrable
domain.

Related tables:

- `organization_relationships` places an organization under another, with a
  relationship type and an effective-dated window.
- Containment relationships are cycle-checked in PostgreSQL. Re-observing an
  ended edge with the same start date preserves its historical end date; a
  renewed relationship is a new effective-dated interval rather than a silent
  rewrite of history.
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

The staff-directory export flattens this normalized model to one row per
published work email. Each row retains the published and parsed name, assignment
and role fields, organization and direct parent, duty location, and the email's
own human-viewable source URL and provenance. Inferred email candidates are not
eligible for this format. Suppression is still applied by the database query and
re-checked in memory immediately before CSV rendering.

An imported row can cite a human source page without pretending that page was
archived. The CSV displays its allowlisted `source_page_url` observation and
retains the artifact document and version identifiers as provenance. The
neutral exporter can expose a caller-selected role-category flag; the Texas
education wrapper selects its teacher category and may supply published grade
attributes from the education extension. Conflicting identities sharing one
organization email are flagged rather than silently collapsed.

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

`source_observations` is insert-only and holds one row per field per record per
**document version**: the raw string, the normalized value, the extraction
method, the confidence, the selector it came from, and an **evidence class**.
Keying on the version rather than the URL is what lets a page change its mind
about someone's title and produce a second observation beside the first, rather
than overwriting it. Replaying the same observation is idempotent; attempting to
reuse its key with different content fails, and database triggers reject both
updates and deletes.

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
`organization_locations`, `external_identifiers`,
`organization_website_candidates`, `people`,
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

- **`recordKey`** is an internal key produced by an adapter for extraction and
  deduplication. Before checkpointing, the crawl engine applies the public-data
  boundary, rejects records that no longer identify a person, and replaces the
  adapter key with an opaque SHA-256 digest of the sanitized record identity.
  Only that 64-character digest may be persisted in a checkpoint, so raw names,
  email addresses and prohibited fields cannot leak into resumability state.
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
| `geographic_area`      | Everyone in an area or any descendant area                    |
| `export_purpose`       | A named export purpose                                        |
| `global`               | Everyone                                                      |

`geographic_area` is inherited down the area tree. Suppressing a state therefore
withholds duty locations in its counties and any areas nested beneath them.

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

`audit_events` is append-only by trigger. A database-owned sequence and a
transaction advisory lock impose one order for application calls and trigger
events, including timestamp ties and an empty chain. The database function
`audit_event_append` is the only appender; the canonical hash covers the prior
hash, sequence, UTC timestamp, actor type and identifier, action, subject and
metadata. Its execution privileges are withheld from `PUBLIC`.

`ComplianceRepository.verifyAuditChain` recomputes the canonical database hash
in sequence order. Changing metadata or a link, reordering rows, or removing an
event is detected.

## Complaint intake

Complaint intake first stores the raw contact value, normalized lookup value,
channel, actor and idempotency key durably. Resolution is a separate transaction
that locks and re-checks the complaint row before it creates any effects, so
concurrent delivery of one idempotency key resolves once. Resolution considers
only exact public work-email or work-phone matches. Exactly one person is
suppressed automatically; zero or multiple people go to
`needs_review` without choosing an arbitrary match. An exact email address can
still receive address-level suppression when the person match is ambiguous.

If suppression fails, the complaint remains durable as `needs_review` with the
failure recorded. Retrying the same idempotency key resumes that complaint and
cannot create a duplicate complaint or orphan suppression.

## Required output fields

A row is evaluated in three independent decisions: the record itself, its
published address, and its inferred candidate. Record-level scopes withhold the
whole row. Email- and domain-level suppression is channel-specific: each
matching published or inferred address is blanked independently, and the row is
kept when another permitted channel remains. A row with no permitted address is
withheld.

The export record persists `withheld_candidate_count`, including candidates
that were considered but never returned to application memory. This makes the
suppression result auditable without exposing the withheld address.

`suppressed_count` and `suppressedPersonIds` count only rows withheld by an
active suppression rule. A direct caller that supplies an address-less row does
not cause it to be mislabeled as suppressed, although the row is still omitted.

Candidates in the `rejected` and `suppressed` states never reach an export at
all: the SQL excludes both before the in-memory re-check ever sees them.

The CSV export carries 35 columns: first name, middle name, last name, full
published name, title, normalized title, role category, job family, seniority,
department, organization, organization type, parent organization, government
level, sector, jurisdiction, duty location city, duty location county, duty
location state, published email, inferred email candidate, email classification,
email validation status, inference confidence, source URL, source type, first
seen, last seen, crawl run, extraction method, confidence, assignment status,
record status.

Published and inferred addresses are separate columns and are never merged.

Migration 0020 allows an unknown organization government level to remain null,
adds frozen run membership and provenance-bearing shared-target associations,
and stores discovery checkpoints on jobs. The CSV also includes all eligible
published email addresses and public work phones. See `STATEWIDE_COLLECTION.md`.
