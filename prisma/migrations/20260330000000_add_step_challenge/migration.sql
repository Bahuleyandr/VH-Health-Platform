-- CreateTable: step_logs — daily step counts per patient
CREATE TABLE IF NOT EXISTS "step_logs" (
  "id"           SERIAL PRIMARY KEY,
  "patient_uid"  UUID        NOT NULL,
  "log_date"     DATE        NOT NULL,
  "steps"        INTEGER     NOT NULL DEFAULT 0,
  "distance_km"  DECIMAL(8,3) NOT NULL DEFAULT 0,
  "active_min"   INTEGER     NOT NULL DEFAULT 0,
  "created_at"   TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  "updated_at"   TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "step_logs_patient_uid_log_date_key" UNIQUE ("patient_uid", "log_date")
);

CREATE INDEX IF NOT EXISTS "step_logs_patient_uid_idx" ON "step_logs" ("patient_uid");
CREATE INDEX IF NOT EXISTS "step_logs_log_date_idx" ON "step_logs" ("log_date");

-- CreateTable: step_profile — leaderboard settings per patient
CREATE TABLE IF NOT EXISTS "step_profile" (
  "id"                    SERIAL PRIMARY KEY,
  "patient_uid"           UUID         NOT NULL UNIQUE,
  "leaderboard_name"      VARCHAR(30)  NOT NULL DEFAULT 'Walker',
  "avatar_color"          VARCHAR(7),
  "opt_out_leaderboard"   BOOLEAN      NOT NULL DEFAULT FALSE,
  "total_steps"           BIGINT       NOT NULL DEFAULT 0,
  "total_distance_km"     DECIMAL(10,3) NOT NULL DEFAULT 0,
  "created_at"            TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  "updated_at"            TIMESTAMP(6) NOT NULL DEFAULT NOW()
);
