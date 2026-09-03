# Engagement campaigns: bind approval to the approved material (OPEN-16)

**Date:** 2026-09-03
**Scope:** `apps/backend/src/services/engagement/engagementCampaignService.js`, a new pure module
`apps/backend/src/services/engagement/campaignApprovalMaterial.js`, migration 763, the Prisma
model and list columns for `engagement_campaigns`, and the engagement unit and deep tests.
**Status:** implemented on `fix/engagement-campaign-approval-material-binding` (off main
`15c4327b4`).
**Origin:** audit row OPEN-16; brief from the coordinating session, 2026-09-03. The hash contents
and the reset behaviour were decided through the advocate / challenger / supervisor protocol; the
challenger's report changed the design (see "What the recipient hash excludes, and why").

## The defect

`approveCampaign` enforces the governed role set, a distinct authenticated approver, a present
submitter identity and a non-empty reason, and records nothing about what was approved. The
transition stamps `approved_by` and `approved_at` only. Three consequences are live on main:

1. `frozen_audience_hash` is written at materialization and returned in responses but never
   compared anywhere in the backend. It also hashes only the caller-supplied `cohort_source`
   metadata plus a candidate count, not the recipient rows, so even a comparison would not have
   bound the audience.
2. `materializeCampaignRecipients` accepts `scheduled` and `running`, so the audience can be re-cut
   under a standing approval; the recipient upsert re-points existing rows to the new snapshot and
   the campaign's `frozen_audience_hash` is overwritten rather than violated.
3. `queueDueCampaignRecipients` selects due recipients by campaign, status and due time only, never
   by the approved snapshot, so recipients materialized after approval dispatch under the earlier
   approval.

There is no update route for campaigns or templates, so the live edit surfaces are post-approval
re-materialization and direct row edits. The binding below covers both.

## Design

### The material

A pure module builds a canonical object from the rows a reviewer is approving and hashes it
(sha256 over stable JSON, the service's existing `hashCohortSource` idiom):

| section | fields |
|---|---|
| campaign | `campaign_type`, `objective`, `audience_kind`, `approval_required_role`, `channels` (sorted), `schedule_policy`, `rate_policy`, `scheduled_at` |
| template | `engagement_template_id`, `notification_template_id`, `channel`, `allowed_variables` (sorted), `phi_classification`, `locale`, `title_template`, `message_template`, `notification_type` |
| audience | `snapshot_id`, `snapshot_kind`, `cohort_hash`, `recipient_count`, `recipients_hash` |

`recipients_hash` is sha256 over the approved snapshot's recipient rows ordered by
`idempotency_key`, each reduced to `idempotency_key`, `patient_uid`, `channel`, `due_at` (ISO),
`required_consent_type` and `variables` (stable JSON).

Excluded: `status`, actor and timestamp columns, snapshot counts other than the recipient count,
tenant-level engagement settings (quiet hours, caps, cooldown: operational policy evaluated per
dispatch and governed by its own settings audit), the consent and suppression verdicts evaluated at
dispatch, outbox and feed identifiers.

`objective` is included because the reviewer approves the stated purpose; `scheduled_at` because
the schedule is named in the brief; `variables` because they are rendered into the message body
and are written only at materialization.

### What the recipient hash excludes, and why

The first draft hashed the recipient rows whole, including `status`. The challenger showed that
this breaks the system on its own dispatch: `queueDueCampaignRecipients` flips a row from
`eligible` to `queued`, `suppressed` or `failed`, so the second queue call, which the existing
deep test requires to return zeroes, would have found a changed hash, refused, and reset the
campaign to draft, and any drip-fed campaign would have locked itself after the first consent
re-check. The rule that follows: the recipient hash covers identity and approved message inputs
only; no column that the dispatch path or a consent re-check writes (`status`,
`suppression_reason`, `consent_id`, `contact_route`, `outbox_id`, `delivery_metadata`, every
`*_at`) may enter it. The unit test pins both halves: every included field flips the hash, every
excluded field leaves it unchanged.

### Why a content hash and not a version counter

A trigger-bumped `material_version` on `engagement_campaigns` cannot see content changes in
`notification_templates` without a second cross-table trigger, and template content is inside the
brief's scope. This repository also just shipped two uncompilable trigger bodies (migrations 744
and 745) and now gates plpgsql in CI, so new trigger surface buys risk for nothing the existing
stable-JSON idiom does not already give. Reopen only if recomputation at queue time is measured as
a real cost.

### Storage (migration 763, forward-only)

`engagement_campaigns` gains `approval_material JSONB` (the canonical object, so a mismatch audit
row is diffable), `approval_material_hash VARCHAR(64)` (written at submit) and
`approved_material_hash VARCHAR(64)` (stamped at approve). A `NOT VALID` CHECK requires
`approved_material_hash` whenever status is `scheduled` or `running`; legacy rows are not rewritten
and any legacy approved campaign cannot dispatch until re-approved, which the queue path reports as
`ENGAGEMENT_APPROVAL_MATERIAL_MISSING`. `frozen_audience_hash` is kept and becomes load-bearing:
it now holds the `recipients_hash` of the approved audience, written at submit and compared at
approve and queue time. It stays because it is already a public response field; deleting it would
be a response-shape change for no benefit.

### Flow

- **submit** (`dry_run` to `pending_approval`) requires a materialized current snapshot with at
  least one recipient row, else `400 ENGAGEMENT_AUDIENCE_NOT_MATERIALIZED`; it computes the
  material and writes `approval_material`, `approval_material_hash` and `frozen_audience_hash` in
  the transition UPDATE.
- **approve** recomputes the material from the live rows inside the transition transaction. On a
  match it stamps `approved_material_hash = approval_material_hash` in the same UPDATE. On a
  mismatch it resets the campaign to `draft` (approval fields and all three hashes cleared), writes
  a transition audit row carrying both hashes and the changed sections, commits, and then throws
  `409 ENGAGEMENT_APPROVAL_MATERIAL_CHANGED`. The reset is committed before the error is raised so
  a rolled-back transaction cannot leave a stale submission standing.
- **materialize** is allowed in `dry_run`. In `pending_approval` it withdraws the submission: the
  campaign returns to `dry_run` with the hashes cleared and an audit row, because the submitted
  audience no longer exists. In `scheduled` or `running` it is refused before any write with
  `409 ENGAGEMENT_APPROVAL_LOCKED`; a post-approval re-cut is the hole itself.
- **queue** opens one tenant transaction that loads the campaign, requires `scheduled` or
  `running` and a stamped `approved_material_hash`, recomputes the live material, and compares. On
  a mismatch it resets the campaign to `draft` with an audit row and a warning log, commits, and
  throws `409 ENGAGEMENT_APPROVAL_MATERIAL_CHANGED` with nothing dispatched. On a match it selects
  the due recipients inside that same transaction with `audience_snapshot_id` equal to the
  campaign's `current_audience_snapshot_id`, so a recipient row from any other snapshot is never
  dispatched. The per-recipient dispatch loop is unchanged.

The reset-to-draft at queue time is a side effect inside a dispatch path. It is deliberate: the
brief requires a materially edited campaign to return to draft, there is no route out of
`scheduled` otherwise, and the audit row plus warning are the observability. If the queue route is
later driven by an unattended scheduler with no log consumer, alerting is a separate ticket.

## Tests

- `apps/backend/src/tests/unit/campaignApprovalMaterial.test.js`: canonical shape; hash stable
  under key order and recipient order; each included field flips the hash; each excluded field and
  every dispatch-state flip (`status`, `suppression_reason`, `consent_id`, `outbox_id`, timestamps)
  leaves it unchanged; a re-materialized audience (different snapshot id or recipient set) flips it.
- `apps/backend/src/tests/engagement-campaigns.deep.test.js` extensions on the real database:
  submit without a materialized audience is refused; a direct `schedule_policy` update between
  submit and approve makes approve refuse and return the campaign to draft with an audit row;
  materialize after approval is refused as locked; a direct `rate_policy` update after approval
  makes queue refuse with nothing dispatched, the campaign back in draft and an audit row; a
  recipient row attached to a different snapshot is never queued; the existing happy path still
  dispatches one recipient and the second queue call still returns zeroes after a real dispatch.
- **Mutation results** (each reverted, tree clean): removing the queue-time comparison turns
  exactly the "edited approved campaign cannot dispatch" test red (1 of 5); removing the snapshot
  filter from the due SELECT turns exactly the foreign-snapshot test red (1 of 5); adding recipient
  `status` to the identity turns the unit test's dispatch-state case red (1 of 46) but is invisible
  to the deep suite, because `loadApprovalMaterial` selects only the identity columns, so a status
  added to the identity function reads as null on both sides. That second line of defence is
  deliberate: the loader's column list and the identity list must be widened together for
  dispatch state to leak into the hash, and the unit test's source contract names the columns
  that must never be.

## Verification

Backend unit suites for engagement; the deep tests against a scratch copy of the template
database migrated to 763; `check-schema-drift.mjs` (`prisma db pull` against the migrated
database must match the committed `schema.prisma`); `db:contracts`; full backend `npm run lint`;
`openapi:check` (no route changes, so no drift expected); canonical CI with `[full-ci]`.

## Revisit triggers

- A new field that reviewers approve (a new campaign column or template attribute) must be added
  to the material; the unit test's included-fields table is the checklist.
- A new column that the dispatch path writes on recipient rows must stay out of the recipient
  hash; the unit test's excluded-fields table is the checklist.
- Spurious `ENGAGEMENT_APPROVAL_MATERIAL_CHANGED` in production means something legitimate is
  rewriting approved material; find the writer, do not widen the exclusions.
