-- 679_mis_report_schedules.sql
--
-- Scheduled MIS report email delivery. Management gets the existing
-- dashboard snapshot reports (services/dashboards/snapshotService.js +
-- teleconsultOpsService.js) by email on a schedule instead of logging in
-- to export them.
--
-- 1. `mis_report_schedules` — tenant-scoped schedule config: which snapshot
--    reports, cadence (daily/weekly/monthly + local send hour in the tenant's
--    timezone, `tenants.settings->>'timezone'` falling back to Asia/Kolkata
--    like the appointment reminder job), recipient emails, enabled flag,
--    last-run bookkeeping. `last_occurrence_key` is the idempotence fence:
--    the hourly dispatch sweep claims a schedule for one local-date
--    occurrence with a compare-and-set on this column, so a schedule can
--    never email the same occurrence twice even across catch-up ticks.
--
-- 2. `mis_report_deliveries` — append-only per-recipient delivery evidence.
--    The platform's honest-delivery rule (migration 609's spirit): a row may
--    claim `acknowledged` only with the SMTP provider's message id captured
--    (`chk_mis_delivery_ack_receipt`); a failed or uncertain SMTP outcome is
--    recorded as exactly that, never as sent. Emails go out through
--    sendEmailNotification receiptMode (the reportService / paymentLink
--    idiom for system emails with attachments) rather than the notification
--    outbox, whose drain path routes rows to push/SMS providers only.
--
-- RLS follows the queue_display_* (migration 450) request-path config-table
-- pattern: permissive tenant_isolation, no GUC default — service writers
-- supply tenant_id explicitly on every statement.

BEGIN;

CREATE TABLE IF NOT EXISTS mis_report_schedules (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                VARCHAR(160) NOT NULL,
  report_keys         TEXT[] NOT NULL,
  cadence             VARCHAR(10) NOT NULL
    CHECK (cadence IN ('daily', 'weekly', 'monthly')),
  send_hour           INTEGER NOT NULL DEFAULT 7
    CHECK (send_hour BETWEEN 0 AND 23),
  send_weekday        INTEGER
    CHECK (send_weekday BETWEEN 0 AND 6),
  send_day_of_month   INTEGER
    CHECK (send_day_of_month BETWEEN 1 AND 28),
  recipients          TEXT[] NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at         TIMESTAMPTZ(6),
  last_status         VARCHAR(20)
    CHECK (last_status IN ('running', 'sent', 'partial', 'failed')),
  last_run_detail     JSONB,
  last_occurrence_key VARCHAR(20),
  created_by          UUID,
  updated_by          UUID,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Report keys are pinned to the snapshot producers that exist today; a new
  -- producer widens this CHECK (and the service registry) in one commit.
  CONSTRAINT chk_mis_schedule_report_keys CHECK (
    cardinality(report_keys) >= 1
    AND report_keys <@ ARRAY[
      'daily-ops', 'opd-daily', 'ip-occupancy', 'doctor-productivity-30d',
      'payer-mix-monthly', 'lab-tat', 'teleconsult-ops'
    ]::text[]
  ),
  CONSTRAINT chk_mis_schedule_recipients CHECK (cardinality(recipients) >= 1),
  CONSTRAINT chk_mis_schedule_weekly_day CHECK (
    cadence <> 'weekly' OR send_weekday IS NOT NULL
  ),
  CONSTRAINT chk_mis_schedule_monthly_day CHECK (
    cadence <> 'monthly' OR send_day_of_month IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_mis_report_schedules_name
  ON mis_report_schedules (tenant_id, LOWER(name));
CREATE INDEX IF NOT EXISTS idx_mis_report_schedules_enabled
  ON mis_report_schedules (tenant_id, enabled);

ALTER TABLE mis_report_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE mis_report_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mis_report_schedules;
CREATE POLICY tenant_isolation ON mis_report_schedules
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

CREATE TABLE IF NOT EXISTS mis_report_deliveries (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  schedule_id         BIGINT NOT NULL REFERENCES mis_report_schedules(id) ON DELETE CASCADE,
  occurrence_key      VARCHAR(20) NOT NULL,
  recipient_email     VARCHAR(320) NOT NULL,
  report_keys         TEXT[] NOT NULL,
  outcome             VARCHAR(20) NOT NULL
    CHECK (outcome IN ('acknowledged', 'rejected', 'uncertain')),
  provider_message_id TEXT,
  failure_code        VARCHAR(120),
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Honest delivery: `acknowledged` requires the provider receipt.
  CONSTRAINT chk_mis_delivery_ack_receipt CHECK (
    outcome <> 'acknowledged' OR provider_message_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_mis_report_deliveries_schedule
  ON mis_report_deliveries (tenant_id, schedule_id, created_at DESC);

ALTER TABLE mis_report_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE mis_report_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mis_report_deliveries;
CREATE POLICY tenant_isolation ON mis_report_deliveries
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

COMMENT ON TABLE mis_report_schedules IS
  'Tenant-scoped schedules that email MIS snapshot reports (dashboards snapshot set) to management on a daily/weekly/monthly cadence.';
COMMENT ON COLUMN mis_report_schedules.last_occurrence_key IS
  'Local-date key (YYYY-MM-DD in the tenant timezone) of the last claimed occurrence; the dispatch sweep''s compare-and-set idempotence fence.';
COMMENT ON TABLE mis_report_deliveries IS
  'Append-only per-recipient SMTP delivery evidence for MIS report schedule runs; acknowledged requires a provider message id.';

COMMIT;
