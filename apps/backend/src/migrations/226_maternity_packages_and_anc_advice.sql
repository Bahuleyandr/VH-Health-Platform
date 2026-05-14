-- 226_maternity_packages_and_anc_advice.sql
--
-- Stage 5 fix chip 3 — obstetric/ANC cluster. Two feature-gap closures:
--
--   1. Maternity delivery/ANC packages. Finding
--      2026-05-09-walk-in-opd-patient-maternity-package-forbidden:
--      patients (and the receptionist quoting prices) had nothing to
--      read. The generic `packages` master (migration 195) already
--      exists, so we seed the maternity packages into it with
--      base_specialty='obstetrics'. Pricing is NOT invented — every
--      seeded row has fixed_price_minor = NULL and a price_status
--      placeholder in metadata for the hospital's finance team to
--      fill in. inclusion/exclusion notes are likewise placeheld.
--
--   2. maternity_anc_advice — trimester-specific patient ANC safety
--      advice. Finding
--      2026-05-10-obstetric-anc-patient-no-kick-counter-or-ob-advice:
--      the patient app has no surface for danger-signs / reduced-fetal-
--      movement / foods-to-avoid / when-to-contact guidance. This
--      builds the delivery mechanism (table + seeded grid). The actual
--      clinical content is NOT invented here — every seeded row holds
--      a [PLACEHOLDER — clinical content review required] string the
--      clinical team replaces with reviewed Hindi copy.
--
-- Re-run safety: both inserts use ON CONFLICT DO NOTHING against
-- existing unique constraints; the table create is IF NOT EXISTS.

BEGIN;

-- ── 1. Maternity packages (seeded into the existing `packages` master) ──
INSERT INTO packages (
  tenant_id, package_code, display_name, description,
  base_specialty, base_procedure_code,
  duration_days, fixed_price_minor, currency, status,
  inclusion_notes, exclusion_notes, metadata
)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  v.package_code,
  v.display_name,
  v.description,
  'obstetrics',
  v.base_procedure_code,
  v.duration_days,
  NULL::BIGINT,                       -- price NOT invented — finance review
  'INR',
  'active',
  '[PLACEHOLDER — clinical/financial review required]',
  '[PLACEHOLDER — clinical/financial review required]',
  '{"price_status": "[PLACEHOLDER — clinical/financial review required]"}'::jsonb
FROM (VALUES
  (
    'MAT-NORMAL-DELIVERY',
    'Normal Delivery Package',
    'Maternity package covering a normal (vaginal) delivery admission.',
    'NORMAL_DELIVERY',
    3
  ),
  (
    'MAT-C-SECTION',
    'Caesarean Section Package',
    'Maternity package covering a planned/emergency caesarean section admission.',
    'CAESAREAN_SECTION',
    5
  ),
  (
    'MAT-ANC-COMPREHENSIVE',
    'Comprehensive Antenatal Care Package',
    'Bundled antenatal care across the pregnancy: routine ANC visits, standard investigations and supplements.',
    'ANC_COMPREHENSIVE',
    280
  )
) AS v(package_code, display_name, description, base_procedure_code, duration_days)
ON CONFLICT (tenant_id, package_code) DO NOTHING;

-- ── 2. maternity_anc_advice — trimester ANC patient-safety advice ──────
CREATE TABLE IF NOT EXISTS maternity_anc_advice (
  id            SERIAL PRIMARY KEY,
  trimester     INTEGER     NOT NULL,
    -- 1 | 2 | 3
  language      VARCHAR(8)  NOT NULL DEFAULT 'hi',
  category      VARCHAR(40) NOT NULL,
    -- danger_signs | fetal_movement | foods_to_avoid | when_to_contact
  title         VARCHAR(160),
  content       TEXT        NOT NULL,
  display_order INTEGER     NOT NULL DEFAULT 0,
  active        BOOLEAN     NOT NULL DEFAULT true,
  tenant_id     UUID        NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT maternity_anc_advice_trimester_chk CHECK (trimester BETWEEN 1 AND 3),
  CONSTRAINT maternity_anc_advice_uniq UNIQUE (tenant_id, trimester, language, category)
);

CREATE INDEX IF NOT EXISTS idx_maternity_anc_advice_lookup
  ON maternity_anc_advice (tenant_id, language, trimester, active);

-- Seed the 3-trimester x 4-category grid with placeholder content.
-- The clinical team replaces `content` with reviewed Hindi copy; the
-- mechanism (table + endpoint) ships now, the medical text does not.
INSERT INTO maternity_anc_advice (trimester, language, category, title, content, display_order)
SELECT t.trimester, 'hi', c.category, NULL,
       '[PLACEHOLDER — clinical content review required]', c.ord
FROM (VALUES (1), (2), (3)) AS t(trimester)
CROSS JOIN (VALUES
  ('danger_signs',    1),
  ('fetal_movement',  2),
  ('foods_to_avoid',  3),
  ('when_to_contact', 4)
) AS c(category, ord)
ON CONFLICT (tenant_id, trimester, language, category) DO NOTHING;

COMMIT;
