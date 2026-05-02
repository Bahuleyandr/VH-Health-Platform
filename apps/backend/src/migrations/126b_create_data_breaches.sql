-- Migration 126b: create data_breaches table.
--
-- Why this is "126b" and not 140: the table is referenced by migration
-- 127_data_processing_activities.sql (ALTER TABLE data_breaches ADD COLUMN
-- regulator_notified_at ...). On environments seeded via `prisma db push`
-- the table existed silently because schema-dump.sql had it. On a fresh
-- runner-only deploy (verified on dalekdefender 2026-05-01) migration 127
-- crashed with `relation "data_breaches" does not exist`. Slot 126b sorts
-- after 126_ed_operational_entities.sql and before 127, so the runner
-- creates the table just in time.
--
-- The schema mirrors what apps/backend/docs/schema-dump.sql shipped via
-- the original `prisma db push`. CREATE / index / column adds all use
-- IF NOT EXISTS so this migration is safe to re-run on environments that
-- already have the table.
--
-- Service callers: breachService.js (reportBreach / containBreach /
-- resolveBreach / notifyRegulator / notifyDataSubjects) and
-- complianceDashboardService.js (getComplianceDashboard's breach grids
-- + Art. 33 72h-clock list).

BEGIN;

CREATE TABLE IF NOT EXISTS data_breaches (
  id                    SERIAL PRIMARY KEY,
  breach_id             VARCHAR(30) UNIQUE,
  severity              VARCHAR(20) NOT NULL,
  description           TEXT NOT NULL,
  affected_records      INTEGER DEFAULT 0,
  affected_patient_uids UUID[],
  discovered_at         TIMESTAMP DEFAULT NOW(),
  reported_by           UUID,
  status                VARCHAR(50) DEFAULT 'open',
  containment_actions   TEXT,
  contained_at          TIMESTAMP,
  resolution_notes      TEXT,
  resolved_at           TIMESTAMP,
  created_at            TIMESTAMP DEFAULT NOW(),
  updated_at            TIMESTAMP DEFAULT NOW()
);

-- Auto-generate the public-facing breach_id (e.g. `BRH-202605-0001`) so
-- breachService.reportBreach can leave it blank on insert. Mirrors the
-- production default from schema-dump.sql line 7154.
ALTER TABLE data_breaches
  ALTER COLUMN breach_id SET DEFAULT (
    'BRH-' || to_char(now(), 'YYYYMM') || '-' ||
    lpad(nextval(pg_get_serial_sequence('data_breaches', 'id'))::text, 4, '0')
  );

CREATE INDEX IF NOT EXISTS idx_data_breaches_severity ON data_breaches(severity);
CREATE INDEX IF NOT EXISTS idx_data_breaches_status   ON data_breaches(status);
CREATE INDEX IF NOT EXISTS idx_data_breaches_discovered_at ON data_breaches(discovered_at);

COMMIT;
