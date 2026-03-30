CREATE TABLE IF NOT EXISTS "step_sessions" (
  "id"           SERIAL PRIMARY KEY,
  "patient_uid"  UUID          NOT NULL,
  "started_at"   TIMESTAMP(6)  NOT NULL DEFAULT NOW(),
  "ended_at"     TIMESTAMP(6),
  "steps"        INTEGER       NOT NULL DEFAULT 0,
  "distance_km"  DECIMAL(8,3)  NOT NULL DEFAULT 0,
  "duration_sec" INTEGER       NOT NULL DEFAULT 0,
  "route_points" JSONB,
  "created_at"   TIMESTAMP(6)  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "step_sessions_patient_uid_idx" ON "step_sessions" ("patient_uid");
CREATE INDEX IF NOT EXISTS "step_sessions_started_at_idx" ON "step_sessions" ("started_at");
