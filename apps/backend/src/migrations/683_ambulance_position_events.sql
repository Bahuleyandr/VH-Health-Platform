-- 683_ambulance_position_events.sql
--
-- Feature wave 6 — config-gated ambulance live GPS position tracking.
--
-- Gap: ambulance_requests (migration 126) carries only static pickup
-- coordinates (pickup_geo_lat/lng) and dispatch/on-scene/arrived timestamps.
-- There is no position-stream table: while a unit is en route the ED sees
-- nothing between "dispatched" and "arrived". prehospital_handovers
-- (migration 570-era NL-14 seam) carries ETA instants (eta_first_at /
-- eta_latest_at) but no geography.
--
-- `ambulance_position_events` is an append-only high-volume fix stream:
--   * One row per GPS fix, keyed to the ambulance_requests row being tracked.
--   * `recorded_at` is the device clock instant of the fix; `received_at` is
--     the server ingest instant. Out-of-order fixes are stored as-is — the
--     "latest position" is DERIVED (ORDER BY recorded_at DESC, id DESC LIMIT 1
--     over the composite index below), so a late-arriving older fix can never
--     regress the live view. No `is_latest` flag, no second materialized
--     table: the index + query is the latest-position lookup.
--   * `source` distinguishes the staff/driver app ingest path ('driver_app',
--     the only wired writer today) from a future partner fleet webhook
--     ('partner_webhook', schema-ready; ambulance_partner_fleet_configs has
--     no inbound auth/callback idiom yet, so that path ships as a documented
--     follow-up rather than half-wired).
--   * Coordinate CHECKs bound lat/lng to the WGS84 envelope; speed, heading
--     and accuracy are optional device-reported extras with sane bounds.
--   * Retention: rows are operational telemetry, not chart content — a
--     scheduler sweep (utils/scheduler.js 'ambulance-position-retention')
--     deletes rows older than the tenant's configured retention window
--     (default 7 days). BIGSERIAL because the stream is high-volume.
--
-- Feature gating is per-tenant via tenants.settings.ambulanceGpsTracking
-- (tenantSettingsService accessor, disabled by default) — deliberately NOT a
-- schema concern, so enabling the feature the day GPS devices arrive is a
-- settings write, not a migration.
--
-- RLS follows the referral_facilities (680) / shift-swap (682) request-path
-- pattern: permissive tenant_isolation; the service always writes tenant_id
-- explicitly from request context.

BEGIN;

CREATE TABLE IF NOT EXISTS ambulance_position_events (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ambulance_request_id  INTEGER NOT NULL
    REFERENCES ambulance_requests(id) ON DELETE CASCADE,
  -- Denormalized unit label from the request at ingest time (the request's
  -- ambulance_unit_id is free text and can be corrected later; the fix keeps
  -- what the unit was called when the fix landed).
  ambulance_unit_id     VARCHAR(80),
  latitude              NUMERIC(10, 6) NOT NULL
    CONSTRAINT chk_ambulance_position_lat CHECK (latitude BETWEEN -90 AND 90),
  longitude             NUMERIC(10, 6) NOT NULL
    CONSTRAINT chk_ambulance_position_lng CHECK (longitude BETWEEN -180 AND 180),
  -- Device-reported extras; all optional.
  speed_kmh             NUMERIC(6, 2)
    CONSTRAINT chk_ambulance_position_speed
      CHECK (speed_kmh IS NULL OR (speed_kmh >= 0 AND speed_kmh <= 400)),
  heading_deg           NUMERIC(5, 2)
    CONSTRAINT chk_ambulance_position_heading
      CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)),
  accuracy_m            NUMERIC(8, 2)
    CONSTRAINT chk_ambulance_position_accuracy
      CHECK (accuracy_m IS NULL OR (accuracy_m >= 0 AND accuracy_m <= 100000)),
  -- Device clock instant of the fix vs server ingest instant.
  recorded_at           TIMESTAMPTZ NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source                VARCHAR(20) NOT NULL DEFAULT 'driver_app'
    CONSTRAINT chk_ambulance_position_source
      CHECK (source IN ('driver_app', 'partner_webhook')),
  -- The authenticated staff uid that posted the fix (driver/crew). NULL is
  -- reserved for the future partner webhook path, which has no VH user.
  reported_by_uid       UUID,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Latest-position + trail lookup: everything reads through this composite
-- index (latest = first row; trail = a bounded scan).
CREATE INDEX IF NOT EXISTS idx_ambulance_position_request_recorded
  ON ambulance_position_events (tenant_id, ambulance_request_id, recorded_at DESC, id DESC);

-- Retention sweep scan (delete WHERE received_at < cutoff).
CREATE INDEX IF NOT EXISTS idx_ambulance_position_received
  ON ambulance_position_events (received_at);

ALTER TABLE ambulance_position_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ambulance_position_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ambulance_position_events;
CREATE POLICY tenant_isolation ON ambulance_position_events
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

COMMENT ON TABLE ambulance_position_events IS
  'Append-only ambulance GPS fix stream per ambulance_requests row. Latest position is derived (recorded_at DESC, id DESC), never flagged, so out-of-order fixes cannot regress the live view. Config-gated per tenant via tenants.settings.ambulanceGpsTracking; retention-swept by the ambulance-position-retention scheduler job.';
COMMENT ON COLUMN ambulance_position_events.recorded_at IS
  'Device clock instant of the GPS fix (client-supplied, bounded-skew-validated at ingest); received_at is the server ingest instant.';
COMMENT ON COLUMN ambulance_position_events.source IS
  'driver_app = staff/driver app ingest (the only wired writer). partner_webhook is schema-ready for a future partner fleet callback; no inbound partner auth idiom exists yet.';

COMMIT;
