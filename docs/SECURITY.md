# Security and data handling

## Secrets

No secret is stored in this repository. `.env.example` names the variables and
holds no values. `.gitignore` excludes `.env` and `.env.*`.

What is recorded is _what is connected_, never the credential:
`directory_platforms` records platforms, `email_validation_results.provider`
records which vendor answered. No table holds an API key, and no code path
writes one.

The shipped validation provider is `NoopValidationProvider`, which marks
everything unvalidated. An unconfigured deployment therefore produces honest
data and cannot spend money by accident.

## The public professional data boundary

This is the substantive limit on what the platform holds. Only what a public
source published about a person's public role.

**Allowed** when the source policy permits: name, published title, department,
organization, professional office address, public work phone, public work email.

**Never collected or inferred**, whatever a page displays: student information;
Social Security or other government identification numbers; dates of birth;
personal financial information; medical information; personal email addresses,
unless a specific future lawful use is explicitly approved; home addresses;
family information; anything behind authentication.

`applyDataBoundary` in `@pan/core` runs on every extracted record before
anything is stored. `scanForProhibitedData` matches on the field label and on
the value, so both `date_of_birth: 1970-01-01` and a birth date under a
differently spelled heading are caught. A drop is counted and the reason is
recorded; the offending value is never written anywhere, including the logs.

Personal-domain email addresses are dropped during ingestion and counted as
`personalEmailsDropped`, so a source publishing them shows up as a number rather
than as rows.

No demographic inference, and no attributes the source did not publish.

`source_documents.storage_key` archives a raw response for auditability. When
the archiver is implemented, archived documents inherit the same retention rules
as the records derived from them, and the boundary applies to what is extracted
from them just as it does to a live page.

## Logging

`createLogger` redacts email addresses, phone numbers, API keys, tokens,
passwords and authorization headers, at the top level and one level down. Person
contact data is business data: it belongs in the database with provenance, not
in a log stream that gets shipped to a third party.

Logs are structured JSON with a service name and an ISO timestamp.

## Access to sources

Public pages only. No authentication, no CAPTCHA bypass, no evasion of technical
restrictions. See `CRAWLING_POLICY.md`. A blocked source is recorded as blocked.

Production collection additionally requires a reviewed source policy with a
recorded human approval. `prohibited` is absolute, and a CHECK constraint makes
a prohibited-but-approved row impossible to store. See `SOURCE_POLICY_REVIEW.md`.

## What a vendor cannot override

A data vendor, an API provider or a partner asserting that their data is
compliant does not change the source policy and does not touch the suppression
list. A vendor is a source: it gets a policy row, reviewed by a person here.
Their assurance can be recorded in `review_notes`. It is never the reason a row
says `permitted`, and it can never make a suppressed person contactable.

## Suppression, opt-outs and complaints

Enforced in the data layer, not left to whoever writes an export. Eleven scopes,
from one email address up to an entire organization subtree, a jurisdiction, a
level of government, a geographic area or everyone.

Every export re-checks immediately before writing, so an opt-out recorded a
second earlier still takes effect, and appearing in a previous export grants
nothing. The subtree rule is implemented twice, as a recursive CTE in SQL and as
`OrganizationHierarchy` in memory, and the two are tested against each other.

Suppression rows are immutable by database trigger: they can be revoked, never
edited or deleted. `audit_events` is append-only and hash-chained, so tampering
with the record of who suppressed what, and when, is detectable.

Anything involving money owed, a refund, a complaint, a legal request, or
health and safety goes to a person. It is not automated here.

## This repository does not send anything

There is no mail transport, no outreach queue and no send API in this codebase.
It collects and manages data. Whatever consumes an export is a separate system
with its own obligations, and the suppression list is not optional for it.

## Before a real crawl or an export leaves the building

- Confirm `CRAWLER_USER_AGENT` and `CRAWLER_CONTACT_URL` point at a real,
  reachable policy page describing the crawl and how to opt out.
- Confirm every domain in scope has a reviewed source policy with a recorded
  production approval (`pnpm admin policies` shows what is still outstanding).
- Confirm suppression entries for any organization that has asked not to be
  contacted are loaded, and consider whether the ask covers a subtree.
- Confirm the export's `suppression_checked_at` and checksum were recorded.
- Confirm nobody is treating an inferred candidate as a verified address. It is
  a separate column, with its own confidence, for exactly that reason.

## Reporting a problem

Security issues and data-handling concerns go to the repository owner directly,
not through a public issue.
