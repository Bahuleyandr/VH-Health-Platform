-- 203_insurance_master_seed_and_admission_link.sql
--
-- Wave-4B-1 — insurance master seeding + admission ↔ policy FK linkage.
--
-- Closes finding:
--   2026-05-09-tpa-insurance-claim-admission-insurance-policy-no-insurer-master
--
-- Background: `payers` + `tpas` master tables have existed since migration 119,
-- but the data was empty in fresh deploys. The admission counter could not
-- pick an insurer from a validated master list — `insurance_policies` writes
-- accepted `insurer_name`/`insurer_code` in the request body but the upsert
-- service silently dropped them because it only consumed `payer_id`/`tpa_id`.
--
-- Two changes:
--
--   1) Seed a representative set of Indian general/health insurers (`payers`)
--      and TPAs (`tpas`) for the default tenant. The list is the typical set
--      a south-Indian tertiary-care hospital empanels with — biased towards
--      what an admission counter actually meets. New tenants get the same
--      starter set; tenant-specific tuning happens via /admin/payers + /admin/tpas
--      once those surfaces ship.
--
--   2) Add `admissions.policy_id` FK → `insurance_policies(id)` so the
--      admission row points at the *specific* policy used (the JSONB
--      `insurance_info` blob remains for free-text fallback / pre-master callers).
--      The triangular link (admission → policy → preauth) is now navigable.
--
-- Re-run safety: `ON CONFLICT (tenant_id, payer_code) DO NOTHING` / `ON CONFLICT
-- (tenant_id, tpa_code) DO NOTHING` (the existing unique constraints). FK
-- addition is wrapped in a NOT EXISTS guard.

BEGIN;

-- ── 1) payers seed ─────────────────────────────────────────────────────

INSERT INTO payers (
  tenant_id, payer_code, display_name, payer_kind,
  contact_email, contact_phone, status, metadata
)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  v.payer_code, v.display_name, v.payer_kind,
  v.contact_email, v.contact_phone, 'active', v.metadata::jsonb
FROM (VALUES
  ('NIA',     'New India Assurance Co Ltd',          'public_insurance',  'cashless@newindia.co.in',  '1800-209-1415', '{"network_tier":"A","cashless_enabled":true}'),
  ('OICL',    'Oriental Insurance Co Ltd',           'public_insurance',  'cashless@orientalinsurance.org.in', '1800-118-485', '{"network_tier":"A","cashless_enabled":true}'),
  ('NICL',    'National Insurance Co Ltd',           'public_insurance',  'cashless@nic.co.in',       '1800-345-0330', '{"network_tier":"A","cashless_enabled":true}'),
  ('UIIC',    'United India Insurance Co Ltd',       'public_insurance',  'cashless@uiic.co.in',      '1800-425-3333', '{"network_tier":"A","cashless_enabled":true}'),
  ('STAR',    'Star Health and Allied Insurance',    'private_insurance', 'cashless@starhealth.in',   '1800-425-2255', '{"network_tier":"A","cashless_enabled":true}'),
  ('ICICILOM','ICICI Lombard General Insurance',     'private_insurance', 'healthclaims@icicilombard.com', '1800-2666', '{"network_tier":"A","cashless_enabled":true}'),
  ('BAJAJ',   'Bajaj Allianz General Insurance',     'private_insurance', 'healthclaims@bajajallianz.co.in', '1800-209-5858', '{"network_tier":"A","cashless_enabled":true}'),
  ('HDFCERGO','HDFC ERGO General Insurance',         'private_insurance', 'healthclaims@hdfcergo.com', '1800-2700-700', '{"network_tier":"A","cashless_enabled":true}'),
  ('MAXBUPA', 'Niva Bupa Health Insurance',          'private_insurance', 'cashless@nivabupa.com',    '1860-500-8888', '{"network_tier":"A","cashless_enabled":true}'),
  ('CARE',    'Care Health Insurance',               'private_insurance', 'cashless@careinsurance.com', '1800-102-4488', '{"network_tier":"A","cashless_enabled":true}'),
  ('TATAAIG', 'Tata AIG General Insurance',          'private_insurance', 'healthclaims@tataaig.com', '1800-266-7780', '{"network_tier":"A","cashless_enabled":true}'),
  ('RELIANCE','Reliance General Insurance',          'private_insurance', 'rgicl.health@relianceada.com', '1800-3009', '{"network_tier":"B","cashless_enabled":true}'),
  ('CGHS',    'Central Government Health Scheme',    'government_scheme', 'helpdesk-cghs@nic.in',     '1800-208-0100', '{"network_tier":"A","cashless_enabled":true}'),
  ('ECHS',    'Ex-Servicemen Contributory Health Scheme', 'government_scheme', 'admin@echs.gov.in', '011-2614-1180', '{"network_tier":"A","cashless_enabled":true}'),
  ('ESIC',    'Employees State Insurance Corporation', 'government_scheme', 'helpdesk@esic.in',       '1800-112-526', '{"network_tier":"B","cashless_enabled":true}'),
  ('PMJAY',   'Ayushman Bharat — PMJAY',             'government_scheme', 'webmaster@pmjay.gov.in',   '14555',         '{"network_tier":"A","cashless_enabled":true,"empanelled":true}'),
  ('CMCHIS',  'Chief Minister''s Comprehensive Health Insurance Scheme (TN)', 'government_scheme', 'cmchis-tn@nic.in', '1800-425-3993', '{"network_tier":"A","cashless_enabled":true,"state":"Tamil Nadu"}'),
  ('OTHER',   'Other / Unknown insurer',             'private_insurance', NULL, NULL, '{"network_tier":"C","cashless_enabled":false,"unknown_placeholder":true}')
) AS v(payer_code, display_name, payer_kind, contact_email, contact_phone, metadata)
ON CONFLICT (tenant_id, payer_code) DO NOTHING;

-- ── 2) tpas seed ───────────────────────────────────────────────────────

INSERT INTO tpas (
  tenant_id, tpa_code, display_name, parent_payer_id,
  irda_license_number, contact_email, contact_phone, status, metadata
)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  v.tpa_code, v.display_name, NULL,
  v.irda, v.contact_email, v.contact_phone, 'active', v.metadata::jsonb
FROM (VALUES
  ('MDINDIA',   'MDIndia Health Insurance TPA',          'IRDA/TPA/02', 'cashless@mdindia.com',       '1800-103-7378', '{"avg_tat_hours":6,"cashless_enabled":true}'),
  ('VIDAL',     'Vidal Health Insurance TPA',            'IRDA/TPA/05', 'cashless@vidalhealthtpa.com', '080-4626-1500', '{"avg_tat_hours":4,"cashless_enabled":true}'),
  ('PARAMOUNT', 'Paramount Health Services TPA',         'IRDA/TPA/06', 'cashless@paramounttpa.com',  '1800-225-589',  '{"avg_tat_hours":8,"cashless_enabled":true}'),
  ('MEDIASSIST','Medi Assist Insurance TPA',             'IRDA/TPA/07', 'cashless@mediassist.in',     '1800-425-9449', '{"avg_tat_hours":6,"cashless_enabled":true}'),
  ('FAMILYHEALTH','Family Health Plan Insurance TPA',    'IRDA/TPA/08', 'preauth@fhpl.net',           '040-6624-6464', '{"avg_tat_hours":8,"cashless_enabled":true}'),
  ('GENINS',    'Genins India Insurance TPA',            'IRDA/TPA/09', 'cashless@geninsindia.com',   '011-4525-2525', '{"avg_tat_hours":10,"cashless_enabled":true}'),
  ('HEALTHINDIA','Health India Insurance TPA',           'IRDA/TPA/10', 'cashless@healthindiatpa.com', '022-6172-0001', '{"avg_tat_hours":8,"cashless_enabled":true}'),
  ('GOOD',      'Good Health Insurance TPA',             'IRDA/TPA/11', 'cashless@ghpltpa.com',       '1800-419-3393', '{"avg_tat_hours":8,"cashless_enabled":true}'),
  ('SAFEWAY',   'Safeway Insurance TPA',                 'IRDA/TPA/12', 'cashless@safewaytpa.in',     '011-4934-1100', '{"avg_tat_hours":12,"cashless_enabled":true}'),
  ('RAKSHA',    'Raksha Health Insurance TPA',           'IRDA/TPA/14', 'cashless@rakshatpa.com',     '011-4503-3333', '{"avg_tat_hours":10,"cashless_enabled":true}'),
  ('ERICSON',   'Ericson Insurance TPA',                 'IRDA/TPA/15', 'cashless@ericsontpa.com',    '1860-425-6660', '{"avg_tat_hours":12,"cashless_enabled":true}'),
  ('OTHER',     'Other / Direct (no TPA)',               NULL,          NULL, NULL, '{"unknown_placeholder":true,"cashless_enabled":false}')
) AS v(tpa_code, display_name, irda, contact_email, contact_phone, metadata)
ON CONFLICT (tenant_id, tpa_code) DO NOTHING;

-- ── 3) admissions.policy_id FK link ────────────────────────────────────

ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS policy_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admissions_policy_id_fkey'
  ) THEN
    ALTER TABLE admissions
      ADD CONSTRAINT admissions_policy_id_fkey
      FOREIGN KEY (policy_id) REFERENCES insurance_policies(id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_admissions_policy_id
  ON admissions(policy_id)
  WHERE policy_id IS NOT NULL;

COMMIT;
