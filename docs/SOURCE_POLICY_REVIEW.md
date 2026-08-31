# Source policy review

Before the crawler collects anything from a source in production, a person has
to have looked at that source and recorded what they found. This document is
that process.

## Why it is a gate and not a note

A crawl that reaches a source nobody reviewed is not a small mistake. It is the
one failure that cannot be undone by deleting rows, because the request already
happened.

So the check is a gate in `CrawlEngine`, evaluated before robots.txt and before
the first fetch. `SourcePolicyRegistry.evaluate` returns a decision, and a
refusal raises `SourcePolicyViolation` and records the target as `policy_hold`.

**The gate exists and is not yet wired for production.** Nothing loads real
`source_policies` rows into the registry at run time, and no operator command
records a review or an approval, so the process below is currently carried out
by writing rows directly. The discovery worker does not go through the gate at
all. Those are production blockers C12 and C13 in `BACKLOG.md`, and both block a
live crawl.

## The four collection statuses

| Status            | Production collection                                       |
| ----------------- | ----------------------------------------------------------- |
| `permitted`       | Allowed                                                     |
| `prohibited`      | **Never.** No approval overrides it                         |
| `review_required` | Blocked until a person records an approval on the row       |
| `unknown`         | Blocked, same as `review_required`                          |
| no policy at all  | Blocked, unless the deployment opts into unreviewed sources |

`prohibited` being absolute is deliberate. If a policy was read wrongly, the fix
is to correct the policy row, which leaves an audit trail. It is not to approve
around it. `source_policies_prohibited_not_approved` is a CHECK constraint, so a
prohibited row that is also approved cannot be stored.

`SourcePolicyOptions.allowUnreviewedSources` exists for a deployment that has
deliberately decided to collect from sources with no policy row. It defaults to
false, because a default-open registry is advisory rather than a control.

Fixture runs are ungated. Nothing is collected from anywhere, so there is
nothing to gate.

## What a policy row records

`source_policies` holds, per domain or URL pattern (and optionally scoped to an
organization or jurisdiction):

- `collection_status`, the gate above;
- `commercial_use_status`, `solicitation_status`, `automated_access_status`,
  each a stance of `permitted`, `prohibited`, `restricted` or `unknown`, so the
  three questions a terms-of-use page usually answers separately stay separate;
- `policy_url`, `policy_text_snapshot` and `policy_text_hash`, so a later change
  to the page is detectable;
- `last_reviewed_at`, `reviewed_by`, `review_notes`;
- `production_approved_by`, `production_approved_at`,
  `production_approval_note`.

An approval is a person's name and a timestamp, or it is not an approval:
`source_policies_approval_complete` requires both or neither.

## The review

1. **Open the source.** The actual page, not a description of it.
2. **Find the terms of use, the acceptable use policy and robots.txt.** Record
   the URL of each in `policy_url` and snapshot the relevant text.
3. **Answer the three questions separately.** Does the policy permit automated
   access? Does it permit commercial use of the data? Does it restrict
   solicitation using the data? These often have different answers on the same
   page, and flattening them loses the one that matters later.
4. **Set `collection_status`.** If the policy prohibits automated access, this
   is `prohibited` and the review is over.
5. **Record who reviewed it and when**, with notes on anything ambiguous.
6. **Approve production collection separately**, with a name, a time and a note.
   Reviewing a source and approving collection from it are two acts, and keeping
   them separate is what makes "someone read this" and "someone decided" both
   visible.

## Re-review

`policy_text_hash` exists so a changed policy page is detectable. Treat a
changed hash as an unreviewed source: it goes back through the process before
the next production run.

## What a vendor cannot do

A data vendor, an API provider or a partner telling us their data is compliant
changes nothing here. It is not a review, it is not an approval, and it does not
touch the suppression list.

If a vendor supplies data, the vendor is a source and gets a policy row like any
other, reviewed by a person on our side. Their assurance can be part of
`review_notes`. It is never the reason a row says `permitted`.

The same applies to suppression. A vendor cannot certify that someone who asked
us not to contact them may be contacted. Suppression is ours, it is immutable
once recorded, and it is enforced twice before an export is written.

## Inspecting the queue

```bash
pnpm admin policies
```

lists sources with `collection_status` in (`review_required`, `unknown`) that
have no production approval: everything the crawler will currently refuse. There
is no command to record a review or an approval yet; both are direct writes to
`source_policies`. See blocker C12.

## Before a production run

- Every domain in the run has a policy row.
- Every row is `permitted`, or `review_required` with a recorded approval.
- No row in the run is `prohibited`.
- `policy_text_hash` matches what the page says today.
- The crawler's user agent points at a reachable page describing the crawl and
  how to ask to be removed.
