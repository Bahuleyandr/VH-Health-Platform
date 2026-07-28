-- 599_clinical_timeline_append_only.sql
--
-- 2026-07-28 canonical-timeline review (verified at main 11abed172):
-- clinical_timeline_events — one half of the canonical-timeline invariant
-- (root CLAUDE.md, docs/CANONICAL_CLINICAL_TIMELINE.md) — had NO database-
-- level append-only enforcement, while its sibling clinical_audit_events has
-- been append-only since migration 324.
--
-- Until now the timeline half was protected only indirectly:
--   * downstream tables hold ON DELETE RESTRICT composite FKs
--     (tenant_id, canonical_timeline_event_id) — e.g. migrations 581, 595,
--     597 — so REFERENCED rows could not be deleted;
--   * three row-scoped guards protect specific families (581 lab-ack
--     receipts, 584 pathway-creation companions, 595 S4 pending-result
--     owner dependencies).
-- But unreferenced, unscoped rows could be DELETEd and ANY row could be
-- UPDATEd by a role with app-level DB write. The timeline is the
-- patient-facing clinical record; tampering must be blocked at the DB layer
-- exactly like the audit tables.
--
-- Fix: attach the shared audit_append_only_guard() (created by migration
-- 324, which every DB reaching this file has already run) as a BEFORE UPDATE
-- OR DELETE trigger. Guard semantics are unchanged (see 324's header):
--   * the mutation is blocked unless the transaction has explicitly opted in
--     via `SET LOCAL app.audit_bypass = 'on'` (or
--     set_config('app.audit_bypass','on',true)), or the effective role is a
--     superuser — the accepted threat boundary (a superuser can drop the
--     trigger anyway; this branch is also what keeps superuser-connected
--     test-fixture cleanup working). The prod app role is NOSUPERUSER
--     NOBYPASSRLS, so app-level DB write cannot bypass.
--   * INSERT is never touched — the append path is unaffected.
--
-- Legitimate UPDATE/DELETE paths audited 2026-07-28: NONE in production
-- code.
--   * No service/controller/route/util issues UPDATE or DELETE against
--     clinical_timeline_events (raw SQL or Prisma model calls) — mutation
--     sites exist only in test fixtures, which run superuser or use
--     src/tests/helpers/auditBypass.js.
--   * auditRetentionService.AUDIT_RETENTION_SINKS deliberately excludes the
--     timeline: it is clinical record, not an audit log — no retention
--     purge applies.
--   * Corrections are compensating events / new revisions under the
--     idempotency-key discipline (docs/CANONICAL_CLINICAL_TIMELINE.md),
--     never in-place edits.
-- Any FUTURE maintenance path must SET LOCAL app.audit_bypass = 'on' inside
-- its own transaction, exactly as the audit retention purge does.
--
-- Firing-order note: BEFORE ROW triggers fire in name order.
-- trg_clinical_timeline_events_append_only sorts before the row-scoped 581/
-- 595 guards, so for a non-superuser role without the bypass this guard
-- raises first; the scoped guards still protect their families inside
-- bypassed maintenance transactions and superuser sessions.
--
-- Proven by src/tests/canonical-timeline-append-only.deep.test.js (mirror of
-- audit-append-only.deep.test.js).
--
-- Idempotent: DROP TRIGGER IF EXISTS then CREATE.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DROP TRIGGER IF EXISTS trg_clinical_timeline_events_append_only
  ON public.clinical_timeline_events;

CREATE TRIGGER trg_clinical_timeline_events_append_only
  BEFORE UPDATE OR DELETE ON public.clinical_timeline_events
  FOR EACH ROW EXECUTE FUNCTION audit_append_only_guard();

-- Provenance row (mirrors migration 324's provenance convention).
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'AUDIT_APPEND_ONLY_TRIGGERS_APPLIED',
  'clinical_timeline_events',
  'clinical_timeline_events',
  jsonb_build_object(
    'migration', '599_clinical_timeline_append_only.sql',
    'audit_ref', 'docs/CANONICAL_CLINICAL_TIMELINE.md#database-level-append-only-enforcement',
    'reason', 'BEFORE UPDATE OR DELETE append-only guard on clinical_timeline_events; UPDATE/DELETE blocked unless app.audit_bypass=on (explicit transaction-local maintenance opt-in) or superuser. Closes the 2026-07-28 review gap: the timeline half of the canonical-timeline invariant had no DB-level append-only enforcement.',
    'bypass_guc', 'app.audit_bypass'
  ),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'AUDIT_APPEND_ONLY_TRIGGERS_APPLIED'
    AND resource = 'clinical_timeline_events'
);

COMMIT;
