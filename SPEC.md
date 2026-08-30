# Specification

The behaviour this system must have. `docs/` explains how it is implemented;
this is what "correct" means.

## Purpose

Collect publicly available U.S. public-sector organization and employee
directory data, one jurisdiction at a time, and manage it so that it can be
exported without ever including someone who has asked not to be contacted, and
without ever collecting from a source nobody has approved.

The system collects and manages data. It sends nothing.

## Scope

Six levels of government, through one neutral core: K-12 education, state
government, county government, municipal and local government, special districts
and public authorities, and federal government.

Education is a sector extension. It is not the shape of the platform, and no
neutral package may assume it.

## Functional requirements

1. Import an authoritative list of public bodies for a jurisdiction, from
   official sources, using official identifiers where they exist.
2. Model an organization's place in a hierarchy as effective-dated
   relationships, not a single parent column, so a reorganization is history
   rather than an overwrite.
3. Never require a state above a federal organization or a federal employee.
4. Find each organization's official website and staff directory.
5. Extract publicly displayed employees and their published work contact
   details.
6. Support every staff role, not only decision-makers.
7. Handle pagination, load-more controls, search interfaces and API-backed
   directories.
8. Normalize, deduplicate and store the data with complete source provenance.
9. Hold title and department on the employment assignment, never on the person.
10. Preserve the published title untouched, and record the method, version and
    confidence of any normalization applied to it.
11. Keep employment evidence separate from contact evidence.
12. Keep published addresses separate from inferred candidates.
13. Support email validation results from a replaceable provider.
14. Refuse production collection from a source marked prohibited, or marked
    review required or unknown without a recorded human approval.
15. Enforce complaints, opt-outs and suppression before any export, including
    suppression of a whole organization subtree.
16. Add further jurisdictions, sectors and directory platforms through
    configuration and reusable packages.

## The public professional data boundary

Collect only what a public source published about a person's public role.

**Allowed** when the source policy permits: name, published title, department,
organization, professional office address, public work phone, public work email.

**Never collected or inferred**, whatever a source displays: student
information; Social Security or other government identification numbers; dates
of birth; personal financial information; medical information; personal email
addresses, unless a specific future lawful use is explicitly approved; home
addresses; family information; anything behind authentication.

## Data classes for email

`published`, `decoded_published`, `inferred_candidate`, `general_inbox`,
`invalid`, `suppressed`. A published address is never overwritten by an inferred
one. An inferred address is never described as verified without a validation
result that says so.

## Required output fields

First name, middle name, last name, full published name, title, normalized
title, role category, job family, seniority, department, organization,
organization type, parent organization, government level, sector, jurisdiction,
duty location city, duty location county, duty location state, published email,
inferred email candidate, email classification, email validation status,
inference confidence, source URL, source type, first seen, last seen, crawl run,
extraction method, confidence, assignment status, record status.

## Operational boundaries

Public sources only, no authentication. Identify the crawler. Respect robots.txt
and access restrictions. Rate limit per domain. Stop and record a blocked source
rather than evading it. Support domain and URL exclusion lists. Store only what
this business purpose needs. A vendor saying data is compliant never overrides
the source policy or the suppression list.

## Definition of done for the foundation

- [x] The repository installs cleanly.
- [x] Linting passes.
- [x] Type checking passes, for sources and for the test suite.
- [x] Tests pass.
- [x] The project builds.
- [x] Local setup is documented.
- [x] Database migrations are reversible.
- [x] A fixture-based crawl completes end to end.
- [x] Repeating the same crawl creates no duplicate records.
- [x] Every output record retains source provenance.
- [x] Published and inferred emails remain distinguishable.
- [x] Suppressed records cannot be exported, including a whole organization
      subtree.
- [x] A new jurisdiction at any level of government can be added without
      modifying the crawler core.
- [x] A new sector can be added without a migration.
- [x] A new directory adapter can be added through the documented interface.
- [x] The neutral core contains no education-specific, state-specific or
      platform-specific code, proven by a test that reads the source.
- [x] No production crawl, deployment, commit or push has occurred without
      authorization.

## Explicitly out of scope for the foundation

Browser rendering, AI extraction, raw response archiving, a graphical admin
dashboard, n8n wiring, and any real validation vendor. See `docs/BACKLOG.md`.
