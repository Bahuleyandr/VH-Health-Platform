-- Migration 195: seed canonical day-care surgical packages.
--
-- Closes finding:
--   2026-05-09-surgical-day-care-admission-no-cataract-package-master
--   (rolled-up into rollup-2026-05-10-db-master-data-gaps)
--
-- Day-care surgical packages bundle OT time + anaesthesia + standard drugs +
-- room rate into a single billable line. The surgical-day-care journey
-- (step 0, admission role) looks up a cataract package at admit time to
-- auto-populate the advance deposit. Without seeded rows, package_id stays
-- null in advance_deposits and the journey abandons.
--
-- Cataract price (₹15,000 = 1,500,000 paise) matches the figure the journey
-- hardcodes for the advance deposit. Other prices are representative INR
-- list prices for the procedure mix; they can be tuned per tenant later.
--
-- Re-run safety: `INSERT ... ON CONFLICT (tenant_id, package_code) DO NOTHING`
-- against the existing unique constraint. The tracker-driven runner already
-- applies each file exactly once per DB, so this is belt-and-suspenders for
-- partial-rerun scenarios (e.g. truncated _migrations + fresh apply).

BEGIN;

INSERT INTO packages (
  tenant_id, package_code, display_name, description,
  base_specialty, base_procedure_code,
  duration_days, fixed_price_minor, currency, status,
  inclusion_notes, exclusion_notes
)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  v.package_code,
  v.display_name,
  v.description,
  v.base_specialty,
  v.base_procedure_code,
  v.duration_days,
  v.fixed_price_minor,
  'INR',
  'active',
  v.inclusion_notes,
  v.exclusion_notes
FROM (VALUES
  (
    'DC-CATARACT-PHACO',
    'Cataract — Phacoemulsification + IOL (day-care)',
    'Day-care cataract surgery: phacoemulsification with foldable monofocal IOL implant. One eye per package.',
    'ophthalmology',
    'PHACO_IOL',
    1,
    1500000::BIGINT,
    'Topical anaesthesia, surgeon fee, OT charges, monofocal IOL, standard pre-op + post-op drops kit, day-care bed for the day.',
    'Premium IOL upgrades (toric / multifocal / EDOF), second-eye surgery, complications requiring overnight admission.'
  ),
  (
    'DC-LAP-APPENDECTOMY',
    'Laparoscopic Appendectomy (day-care)',
    'Day-care laparoscopic appendectomy for uncomplicated appendicitis. Same-day discharge if recovery is uneventful.',
    'general_surgery',
    'LAP_APPENDECTOMY',
    1,
    6500000::BIGINT,
    'General anaesthesia, surgeon + anaesthetist fees, OT charges, single-use laparoscopic ports, standard analgesia + antibiotics, day-care bed.',
    'Conversion to open procedure, complicated/perforated appendicitis requiring IPD admission, prolonged stay >24h.'
  ),
  (
    'DC-HERNIA-INGUINAL',
    'Inguinal Hernia Repair — Lichtenstein (day-care)',
    'Day-care unilateral inguinal hernia repair with mesh. Local or spinal anaesthesia depending on patient fitness.',
    'general_surgery',
    'HERNIA_INGUINAL',
    1,
    4500000::BIGINT,
    'Anaesthesia (local/spinal), surgeon fee, OT charges, standard polypropylene mesh, post-op analgesia, day-care bed.',
    'Bilateral repair, recurrent hernia, laparoscopic approach, premium mesh, overnight stay.'
  ),
  (
    'DC-ESWL',
    'Extracorporeal Shock Wave Lithotripsy (day-care)',
    'Day-care urology procedure: shock-wave lithotripsy for renal / ureteric stones up to 2 cm.',
    'urology',
    'ESWL',
    1,
    3000000::BIGINT,
    'Sedation, urologist fee, lithotripter session, post-procedure observation, day-care bed.',
    'Additional sessions, ureteric stenting, complications requiring admission, contrast imaging.'
  ),
  (
    'DC-BASIC',
    'Day-care Basic — Generic Short Stay',
    'Generic day-care admission for short procedures or observation when no specialty-specific package applies.',
    'general',
    NULL,
    1,
    800000::BIGINT,
    'Day-care bed for the day, nursing care, basic medications, one consultation.',
    'OT charges, specialty consumables, anaesthesia, diagnostics beyond bedside vitals.'
  ),
  (
    'DC-OT-MINOR',
    'OT — Minor Procedure (day-care)',
    'Minor OT procedures performed under local anaesthesia: I&D, suturing, lump excision, nail removal, biopsy.',
    'general_surgery',
    'OT_MINOR',
    1,
    500000::BIGINT,
    'Local anaesthesia, surgeon fee, OT-minor charges, dressings + standard analgesia.',
    'General anaesthesia, sedation, specialty implants, histopathology charges.'
  )
) AS v(
  package_code, display_name, description,
  base_specialty, base_procedure_code,
  duration_days, fixed_price_minor,
  inclusion_notes, exclusion_notes
)
ON CONFLICT (tenant_id, package_code) DO NOTHING;

COMMIT;
