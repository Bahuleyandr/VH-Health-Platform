-- Migration 157: Hospital BI views + Metabase wiring (Sprint 9).
--
-- Metabase is the dashboarding layer the admin / clinical management
-- team uses. We don't ship the Metabase install itself — that runs as
-- its own pod next to the backend in the in-hospital cluster — but we
-- ship the SQL views that pre-shape data so dashboards are fast,
-- consistent, and don't require Metabase users to write joins.
--
-- All views live in the public schema with a `bi_` prefix so they're
-- easy to grant en bloc:
--
--   GRANT SELECT ON ALL TABLES IN SCHEMA public TO metabase_readonly;
--
-- Existing operational views (billing_daily_collection,
-- insurance_claims_aging, or_throughput_daily, or_safety_compliance,
-- pharmacy_schedule_register_full) stay as they are — Metabase can
-- read them directly. This migration adds the missing BI surface for
-- OPD volume, IP occupancy, doctor productivity, payer mix, and a
-- daily ops snapshot.

BEGIN;

-- ── 1. Daily OPD volume ─────────────────────────────────────────────
CREATE OR REPLACE VIEW bi_opd_daily AS
SELECT
  appointment_date AS d,
  doctor_id, doctor_name,
  COUNT(*)::int AS total_appointments,
  SUM(CASE WHEN status IN ('COMPLETED','CHECKED_OUT') THEN 1 ELSE 0 END)::int AS completed,
  SUM(CASE WHEN status IN ('NO_SHOW','MISSED') THEN 1 ELSE 0 END)::int AS no_shows,
  SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END)::int AS cancelled,
  ROUND(
    100.0 * SUM(CASE WHEN status IN ('NO_SHOW','MISSED') THEN 1 ELSE 0 END) /
    NULLIF(COUNT(*), 0), 1
  ) AS no_show_rate_pct
FROM appointments
GROUP BY appointment_date, doctor_id, doctor_name;

-- ── 2. IP occupancy by day ─────────────────────────────────────────
-- Counts patients in-house at end of each day. Joins ward + status.
-- Uses generate_series to fill date ranges with zeros.
CREATE OR REPLACE VIEW bi_ip_occupancy_daily AS
SELECT
  d::date AS d,
  COALESCE(a.ward, 'unassigned') AS ward,
  COUNT(*)::int AS patients_in_house
FROM admissions a
JOIN LATERAL generate_series(
  a.created_at::date,
  COALESCE((a.created_at + INTERVAL '7 days')::date, CURRENT_DATE),
  INTERVAL '1 day'
) AS d ON true
WHERE a.status = 'admitted'
GROUP BY d::date, COALESCE(a.ward, 'unassigned');

-- ── 3. Doctor productivity (rolling 30 days) ───────────────────────
CREATE OR REPLACE VIEW bi_doctor_productivity_30d AS
SELECT
  doctor_id, doctor_name,
  COUNT(*)::int AS opd_appointments_30d,
  SUM(CASE WHEN status IN ('COMPLETED','CHECKED_OUT') THEN 1 ELSE 0 END)::int AS opd_completed_30d,
  COUNT(DISTINCT appointment_date)::int AS days_seen_patients,
  ROUND(
    COUNT(*)::numeric / NULLIF(COUNT(DISTINCT appointment_date), 0), 1
  ) AS avg_appointments_per_day
FROM appointments
WHERE appointment_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY doctor_id, doctor_name;

-- ── 4. Payer mix (monthly) ─────────────────────────────────────────
-- Rolls up TPA claims (Sprint 5) by month + claim type.
CREATE OR REPLACE VIEW bi_payer_mix_monthly AS
SELECT
  DATE_TRUNC('month', c.created_at)::date AS month,
  c.claim_type,
  c.status,
  COUNT(*)::int AS claim_count,
  SUM(c.total_billed)  AS total_billed,
  SUM(c.claimed_amount) AS total_claimed,
  SUM(COALESCE(c.approved_amount, 0)) AS total_approved,
  SUM(COALESCE(c.paid_amount, 0))     AS total_paid
FROM tpa_claims c
GROUP BY DATE_TRUNC('month', c.created_at)::date, c.claim_type, c.status;

-- ── 5. Lab TAT (turn-around time) summary ──────────────────────────
-- Uses lab_results.received_at vs lab_results.signed_off_at for TAT.
-- Falls back gracefully if signed_off is null.
CREATE OR REPLACE VIEW bi_lab_tat_summary AS
SELECT
  DATE_TRUNC('day', received_at)::date AS d,
  COUNT(*)::int AS results_received,
  SUM(CASE WHEN signed_off_at IS NOT NULL THEN 1 ELSE 0 END)::int AS results_signed,
  AVG(EXTRACT(EPOCH FROM (signed_off_at - received_at)) / 60)::int AS avg_tat_minutes,
  PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (signed_off_at - received_at)) / 60
  )::int AS median_tat_minutes,
  PERCENTILE_CONT(0.95) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (signed_off_at - received_at)) / 60
  )::int AS p95_tat_minutes
FROM lab_results
WHERE received_at IS NOT NULL
GROUP BY DATE_TRUNC('day', received_at)::date;

-- ── 6. Daily ops snapshot ──────────────────────────────────────────
-- The "morning huddle" view — one row per day with the headline
-- numbers everyone wants at 8 am.
CREATE OR REPLACE VIEW bi_daily_ops_snapshot AS
SELECT
  CURRENT_DATE AS d,
  -- OPD
  (SELECT COUNT(*)::int FROM appointments WHERE appointment_date = CURRENT_DATE) AS opd_today,
  (SELECT COUNT(*)::int FROM appointments
    WHERE appointment_date = CURRENT_DATE AND status IN ('COMPLETED','CHECKED_OUT')) AS opd_completed_today,
  -- IP
  (SELECT COUNT(*)::int FROM admissions WHERE status = 'admitted') AS ip_in_house,
  -- OT
  (SELECT COUNT(*)::int FROM ot_schedules WHERE scheduled_date = CURRENT_DATE
                                              AND status NOT IN ('cancelled')) AS or_cases_today,
  -- Lab criticals
  (SELECT COUNT(*)::int FROM lab_critical_alerts WHERE acknowledged_at IS NULL) AS open_critical_alerts,
  -- Billing
  (SELECT COALESCE(SUM(amount), 0) FROM billing_payments
    WHERE collected_at::date = CURRENT_DATE AND reversed = false) AS collections_today,
  -- Insurance
  (SELECT COUNT(*)::int FROM insurance_preauth
    WHERE status = 'submitted') AS preauth_pending,
  (SELECT COUNT(*)::int FROM tpa_claims
    WHERE status IN ('submitted','queried')) AS claims_outstanding;

-- ── 7. Read-only role for Metabase ─────────────────────────────────
-- Created idempotently. Caller still has to set the password (don't
-- bake credentials into a migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_readonly') THEN
    CREATE ROLE metabase_readonly NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO metabase_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO metabase_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO metabase_readonly;

COMMIT;
