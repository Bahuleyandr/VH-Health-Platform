-- 302_india_evidence_acceptance_guard.sql
--
-- Prevent India deployability controls from being accepted by status flip
-- alone. A launch-ready evidence row must point to evidence and name the
-- verifier/timestamp. Exceptions and not-applicable decisions also need notes.

BEGIN;

UPDATE india_compliance_evidence
   SET status = 'in_progress',
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'acceptance_reset_by_migration', '302_india_evidence_acceptance_guard.sql',
         'reason', 'Accepted status lacked evidence_uri, verified_by, verified_at, or required notes'
       ),
       updated_at = NOW()
 WHERE status IN ('verified', 'accepted_exception', 'not_applicable')
   AND (
     verified_by IS NULL
     OR verified_at IS NULL
     OR NULLIF(BTRIM(COALESCE(evidence_uri, '')), '') IS NULL
     OR (
       status IN ('accepted_exception', 'not_applicable')
       AND NULLIF(BTRIM(COALESCE(notes, '')), '') IS NULL
     )
   );

ALTER TABLE india_compliance_evidence
  DROP CONSTRAINT IF EXISTS india_compliance_evidence_acceptance_evidence_check;

ALTER TABLE india_compliance_evidence
  ADD CONSTRAINT india_compliance_evidence_acceptance_evidence_check
  CHECK (
    status NOT IN ('verified', 'accepted_exception', 'not_applicable')
    OR (
      verified_by IS NOT NULL
      AND verified_at IS NOT NULL
      AND NULLIF(BTRIM(COALESCE(evidence_uri, '')), '') IS NOT NULL
      AND (
        status NOT IN ('accepted_exception', 'not_applicable')
        OR NULLIF(BTRIM(COALESCE(notes, '')), '') IS NOT NULL
      )
    )
  );

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'INDIA_EVIDENCE_ACCEPTANCE_GUARD_APPLIED',
  'india_compliance_evidence',
  'acceptance_evidence_check',
  jsonb_build_object(
    'migration', '302_india_evidence_acceptance_guard.sql',
    'required_for_accepted_statuses', jsonb_build_array('evidence_uri', 'verified_by', 'verified_at'),
    'notes_required_for', jsonb_build_array('accepted_exception', 'not_applicable')
  ),
  NOW()
WHERE EXISTS (
  SELECT 1
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1
    FROM audit_logs
   WHERE action = 'INDIA_EVIDENCE_ACCEPTANCE_GUARD_APPLIED'
     AND resource = 'india_compliance_evidence'
     AND resource_id = 'acceptance_evidence_check'
);

COMMIT;
