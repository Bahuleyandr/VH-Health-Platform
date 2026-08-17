-- 692_sos_alerts_is_test_alert.sql
--
-- Persist the drill marker the API already accepts (createAlert isTestAlert).
-- Creation-time fan-out already skips tests; this column lets the
-- sos-alert-age-escalation sweep (677/#874) skip them too, so a drill can
-- exercise the responder loop without paging the emergency team or ops.
-- DEFAULT FALSE is rollout-safe and correct: an old-image writer that omits
-- the column produces a REAL alert (fail-safe direction), and this default
-- can never mint a blocked/armed state (contrast 676's disarm rationale) —
-- so, unlike 676's transitional defaults, this one is deliberately kept.

ALTER TABLE sos_alerts
  ADD COLUMN IF NOT EXISTS is_test_alert BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN sos_alerts.is_test_alert IS
  'TRUE for drill/test alerts: creation fan-out and the age-escalation sweep skip external alerting; responder transitions still work.';
