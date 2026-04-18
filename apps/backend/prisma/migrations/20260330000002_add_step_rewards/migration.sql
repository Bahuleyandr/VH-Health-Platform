-- step_badges
CREATE TABLE IF NOT EXISTS "step_badges" (
  "id"          SERIAL PRIMARY KEY,
  "patient_uid" UUID         NOT NULL,
  "badge_type"  VARCHAR(50)  NOT NULL,
  "earned_at"   TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "step_badges_patient_uid_badge_type_key" UNIQUE ("patient_uid", "badge_type")
);
CREATE INDEX IF NOT EXISTS "step_badges_patient_uid_idx" ON "step_badges" ("patient_uid");

-- step_vouchers
CREATE TABLE IF NOT EXISTS "step_vouchers" (
  "id"           SERIAL PRIMARY KEY,
  "patient_uid"  UUID         NOT NULL,
  "voucher_code" VARCHAR(20)  NOT NULL UNIQUE,
  "reward_type"  VARCHAR(50)  NOT NULL,
  "description"  TEXT         NOT NULL,
  "discount_pct" INTEGER      NOT NULL DEFAULT 0,
  "free_consult" BOOLEAN      NOT NULL DEFAULT FALSE,
  "issued_at"    TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  "expires_at"   TIMESTAMP(6) NOT NULL,
  "redeemed_at"  TIMESTAMP(6),
  "month_year"   VARCHAR(7)   NOT NULL
);
CREATE INDEX IF NOT EXISTS "step_vouchers_patient_uid_idx" ON "step_vouchers" ("patient_uid");
CREATE INDEX IF NOT EXISTS "step_vouchers_voucher_code_idx" ON "step_vouchers" ("voucher_code");

-- step_monthly_winners
CREATE TABLE IF NOT EXISTS "step_monthly_winners" (
  "id"          SERIAL PRIMARY KEY,
  "patient_uid" UUID         NOT NULL,
  "rank"        INTEGER      NOT NULL,
  "month_year"  VARCHAR(7)   NOT NULL,
  "total_steps" BIGINT       NOT NULL,
  "voucher_id"  INTEGER,
  "created_at"  TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "step_monthly_winners_patient_uid_month_year_key" UNIQUE ("patient_uid", "month_year")
);
CREATE INDEX IF NOT EXISTS "step_monthly_winners_month_year_idx" ON "step_monthly_winners" ("month_year");
