-- Sign-off group 2026-07-13: owner (cardiologist) confirmed the Code-STEMI
-- time targets to the current ACC/AHA + ESC international standards. Migration
-- 560 shipped the settings table intentionally unseeded; now that the owner
-- has confirmed the values we seed them as the per-tenant default.
--
-- Two of the four confirmed targets map to existing columns and become the
-- live SLA clocks:
--   door-to-ECG        <= 10 min  -> door_to_ecg_target_minutes
--   door-to-balloon    <= 90 min  -> door_to_balloon_target_minutes  (primary PCI)
--
-- The other two confirmed values are recorded in metadata as owner-confirmed
-- REFERENCE values, not wired as live SLA clocks:
--   FMC-to-balloon     <= 90 min (<=120 if inter-hospital transfer)
--   door-to-needle     <= 30 min (fibrinolysis)
-- door-to-needle is the fibrinolysis alternative pathway — mutually exclusive
-- with primary-PCI door-to-balloon — so it is deliberately NOT emitted as an
-- always-on SLA clock in the current single-pathway model; wiring it needs a
-- schema + SLA-rule-code extension (see stemi_pathway_settings columns and
-- migration 562 rule whitelist). door_to_lab is left NULL (no owner value).
--
-- The pathway stays DISABLED: this seeds targets only. Enabling still requires
-- the owner-supplied clock-definition + activation-criteria provenance via the
-- admin settings endpoint (CONSTRAINT stemi_pathway_settings_enabled_owner_metadata).
-- Existing per-tenant target customisations are preserved (COALESCE-fill only).

BEGIN;

WITH stemi_confirmed (door_to_ecg_target_minutes, door_to_balloon_target_minutes, metadata) AS (
  VALUES (
    10,
    90,
    '{
      "stemi_targets_confirmed": {
        "source": "ACC/AHA + ESC current international standards",
        "confirmed_on": "2026-07-13",
        "confirmed_by": "owner_cardiologist",
        "door_to_ecg_minutes": 10,
        "door_to_balloon_primary_pci_minutes": 90,
        "fmc_to_balloon_minutes": 90,
        "fmc_to_balloon_transfer_minutes": 120,
        "door_to_needle_fibrinolysis_minutes": 30,
        "wired_as_sla_clock": ["door_to_ecg", "door_to_balloon"],
        "reference_only": ["fmc_to_balloon", "door_to_needle_fibrinolysis"],
        "reference_only_note": "FMC-to-balloon and door-to-needle are owner-confirmed reference values. door-to-needle is the fibrinolysis alternative to primary-PCI door-to-balloon (mutually exclusive) and is not wired as a live SLA clock in the current single-pathway model.",
        "signoff_2026_07_13": true
      }
    }'::jsonb
  )
)
INSERT INTO stemi_pathway_settings (
  tenant_id,
  door_to_ecg_target_minutes,
  door_to_balloon_target_minutes,
  metadata
)
SELECT
  t.id,
  s.door_to_ecg_target_minutes,
  s.door_to_balloon_target_minutes,
  s.metadata
FROM tenants t
CROSS JOIN stemi_confirmed s
ON CONFLICT (tenant_id) DO UPDATE SET
  -- COALESCE-fill: seed defaults only where a tenant has not already set its
  -- own target; never clobber a customised value.
  door_to_ecg_target_minutes = COALESCE(
    stemi_pathway_settings.door_to_ecg_target_minutes, EXCLUDED.door_to_ecg_target_minutes),
  door_to_balloon_target_minutes = COALESCE(
    stemi_pathway_settings.door_to_balloon_target_minutes, EXCLUDED.door_to_balloon_target_minutes),
  metadata = stemi_pathway_settings.metadata || EXCLUDED.metadata,
  updated_at = NOW();

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'SIGNOFF_STEMI_PATHWAY_TARGETS_SEEDED',
  'stemi_pathway_settings',
  'stemi_targets_confirmed',
  jsonb_build_object(
    'migration', '573_stemi_pathway_target_seed.sql',
    'program', 'audit sign-off group 2026-07-13',
    'reason', 'Owner-confirmed ACC/AHA+ESC STEMI targets seeded (door-to-ECG 10, door-to-balloon 90); pathway stays disabled until owner provenance supplied.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1
    FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1
    FROM audit_logs
   WHERE action = 'SIGNOFF_STEMI_PATHWAY_TARGETS_SEEDED'
);

COMMIT;
