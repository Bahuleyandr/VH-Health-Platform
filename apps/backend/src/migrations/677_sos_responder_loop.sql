-- 677_sos_responder_loop.sql
--
-- HIGH-1 (gap-audit fold-in): close the SOS responder loop.
--
-- 1. Persist what the responder actually said/did. The responder endpoints
--    validate `responseMessage` (required) and `resolutionNotes` (optional,
--    <=500 chars) — src/validators/sosValidators.js:58-66 — but the columns
--    never existed, so the validated text was dropped on the floor. Add them;
--    the respond/resolve controllers now bind them in the UPDATE.
--
-- 2. `last_escalated_at` backs the new `sos-alert-age-escalation` scheduler
--    sweep (src/services/sosEscalationService.js): a never-acknowledged
--    ACTIVE alert is escalated one severity step per window and re-fanned-out
--    to the emergency team. Stamping this column is what makes the sweep
--    idempotent per window instead of re-escalating on every tick.
--
-- 3. Seed the global `sos_response_ack` workflow_sla_rules row (migration-641
--    shape: tenant_id NULL global default, WHERE NOT EXISTS guard) so SOS
--    alert creation can start a canonical workflow_sla_instances clock and
--    respond/resolve/cancel can complete it (canonical clinical timeline
--    invariant — SLA-backed actions create/update workflow_sla_instances).
--    target_minutes mirrors sosConfig ESCALATION_TIMEOUT (5 minutes).

ALTER TABLE sos_alerts
  ADD COLUMN IF NOT EXISTS response_message  TEXT,
  ADD COLUMN IF NOT EXISTS resolution_notes  TEXT,
  ADD COLUMN IF NOT EXISTS last_escalated_at TIMESTAMP;

COMMENT ON COLUMN sos_alerts.response_message IS
  'Responder''s message recorded at ACTIVE->RESPONDING (POST /sos/responder/respond/:alertId, required by validator).';
COMMENT ON COLUMN sos_alerts.resolution_notes IS
  'Responder''s notes recorded at ->RESOLVED (POST /sos/responder/resolve/:alertId, optional, <=500 chars at the validator).';
COMMENT ON COLUMN sos_alerts.last_escalated_at IS
  'Last time the sos-alert-age-escalation sweep escalated/re-notified this alert; NULL until the first sweep action.';

INSERT INTO workflow_sla_rules
  (tenant_id, rule_code, title, trigger_event_type, target_minutes, severity,
   owner_role_codes, escalation_role_codes, enabled, metadata, created_at, updated_at)
SELECT NULL::uuid, rule_code, title, trigger_event_type, target_minutes, severity,
       owner_role_codes, escalation_role_codes, TRUE, metadata, NOW(), NOW()
  FROM (
    VALUES
      (
        'sos_response_ack',
        'SOS alert - responder acknowledgement',
        'sos.raised',
        5,
        'critical',
        ARRAY['EMERGENCY_RESPONDER','SECURITY','DRIVER']::text[],
        ARRAY['ADMIN','CMO','MEDICAL_SUPERINTENDENT']::text[],
        '{"source":"sos_responder_loop","description":"Time from SOS alert raised to first responder acknowledgement (ACTIVE -> RESPONDING)"}'::jsonb
      )
  ) AS seed(rule_code, title, trigger_event_type, target_minutes, severity,
            owner_role_codes, escalation_role_codes, metadata)
 WHERE NOT EXISTS (
   SELECT 1
     FROM workflow_sla_rules existing
    WHERE existing.tenant_id IS NULL
      AND existing.rule_code = seed.rule_code
 );
