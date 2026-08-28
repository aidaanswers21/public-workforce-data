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

## Logging

`createLogger` redacts email addresses, phone numbers, API keys, tokens,
passwords and authorization headers, at the top level and one level down. Person
contact data is business data: it belongs in the database with provenance, not
in a log stream that gets shipped to a third party.

Logs are structured JSON with a service name and an ISO timestamp.

## Data minimization

Only fields needed for this internal business purpose are collected. In
particular:

- **No student information, ever.** Not names, not schedules, not photographs,
  not rosters.
- No personal (non-work) contact details.
- No demographic inference, and no attributes not published by the source.
- `source_pages.storage_key` archives a raw response for auditability. When the
  archiver is implemented, archived pages inherit the same retention rules as
  the records derived from them.

## Access to sources

Public pages only. No authentication, no CAPTCHA bypass, no evasion of technical
restrictions. See `CRAWLING_POLICY.md`. A blocked source is recorded as blocked.

## Suppression, opt-outs and complaints

Enforced in the data layer, not left to whoever writes an export. Every export
re-checks immediately before writing, so an opt-out recorded a second earlier
still takes effect, and appearing in a previous export grants nothing.

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
- Confirm suppression entries for any district that has asked not to be
  contacted are loaded.
- Confirm the export's `suppression_checked_at` and checksum were recorded.
- Confirm nobody is treating an inferred candidate as a verified address. It is
  a separate column, with its own confidence, for exactly that reason.

## Reporting a problem

Security issues and data-handling concerns go to the repository owner directly,
not through a public issue.
