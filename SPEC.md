# Specification

The behaviour this system must have. `docs/` explains how it is implemented;
this is what "correct" means.

## Purpose

Collect publicly available U.S. K-12 school and employee directory data for one
state at a time, starting with Texas, and manage it so that it can be exported
without ever including someone who has asked not to be contacted.

The system collects and manages data. It sends nothing.

## Functional requirements

1. Import the authoritative list of public school districts and schools for a
   state, from official sources, using official identifiers where they exist.
2. Find each district and school's official website and staff directory.
3. Extract publicly displayed employees and their published contact details.
4. Support every staff role, not only decision-makers.
5. Handle pagination, load-more controls, search interfaces and API-backed
   directories.
6. Normalize, deduplicate and store the data with complete source provenance.
7. Keep published addresses separate from inferred candidates.
8. Support email validation results from a replaceable provider.
9. Enforce complaints, opt-outs and suppression before any export.
10. Add further states through configuration and reusable adapters.

## Data classes for email

`published`, `decoded_published`, `inferred_candidate`, `general_inbox`,
`invalid`, `suppressed`. A published address is never overwritten by an inferred
one. An inferred address is never described as verified without a validation
result that says so.

## Required output fields

First name, middle name, last name, full published name, title, normalized
title, role category, department, school, district, county, state, published
email, inferred email candidate, email classification, email validation status,
inference confidence, source URL, source type, first seen, last seen, crawl run,
extraction method, confidence, active/inactive status.

## Operational boundaries

Public sources only, no authentication. Identify the crawler. Respect robots.txt
and access restrictions. Rate limit per domain. Stop and record a blocked source
rather than evading it. Support domain and URL exclusion lists. Store only what
this business purpose needs. Never collect student information.

## Definition of done for the foundation

- [x] The repository installs cleanly.
- [x] Linting passes.
- [x] Type checking passes.
- [x] Tests pass.
- [x] The project builds.
- [x] Local setup is documented.
- [x] Database migrations are reversible.
- [x] A fixture-based crawl completes end to end.
- [x] Repeating the same crawl creates no duplicate records.
- [x] Every output record retains source provenance.
- [x] Published and inferred emails remain distinguishable.
- [x] Suppressed records cannot be exported.
- [x] A new state can be added without modifying the crawler core.
- [x] A new directory adapter can be added through the documented interface.
- [x] No production crawl, deployment, commit or push has occurred without
      authorization.

## Explicitly out of scope for the foundation

Browser rendering, AI extraction, raw response archiving, a graphical admin
dashboard, n8n wiring, and any real validation vendor. See `docs/BACKLOG.md`.
