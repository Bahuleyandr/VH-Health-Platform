import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { getUnifiedActiveAllergies, rankSeverity, SEVERE_BLOCK_RANK } from '../../services/clinical/allergySourceService.js';
import { evaluateDrugKb } from '../../services/clinical/drugKnowledgeBaseService.js';

/**
 * Per-dose mg/kg ceilings for common paediatric drugs. Names matched
 * case-insensitive substring against the medication name. Conservative
 * limits — production should pull from a curated drug master rather than
 * this seed list. See finding
 * 2026-05-08-pediatric-opd-doctor-no-weight-based-dose-check.
 */
const PAEDIATRIC_MG_PER_KG = {
  paracetamol: 15,        // 10–15 mg/kg/dose, 60 mg/kg/day max
  acetaminophen: 15,
  ibuprofen: 10,          // 5–10 mg/kg/dose, 40 mg/kg/day max
  amoxicillin: 25,        // 20–40 mg/kg/dose
  azithromycin: 10,
  cefixime: 8,
  ciprofloxacin: 15,
  ondansetron: 0.15,      // 0.1–0.15 mg/kg/dose
  cetirizine: 5,          // total mg, age-dependent — flag aggressive overdose
};

const DOSE_VALUE_RX = /(-?\d+(?:\.\d+)?)\s*(mg|mcg|µg|g|ml)\b/i;
const DOSE_VALUE_GLOBAL_RX = /(-?\d+(?:\.\d+)?)\s*(mg|mcg|µg|g|ml)\b/gi;
const MG_PER_KG_RX = /(\d+(?:\.\d+)?)\s*mg\s*\/\s*kg\b/i;
const MG_PER_KG_GLOBAL_RX = /(\d+(?:\.\d+)?)\s*mg\s*\/\s*kg\b/gi;

// Syrup-strength patterns in medication names. Catch "125mg/5ml",
// "100 mg/ml", "100mg / 5 ml", etc. Returns mg-per-ml when present.
const STRENGTH_RX = /(\d+(?:\.\d+)?)\s*mg\s*\/\s*(\d+(?:\.\d+)?)?\s*ml\b/i;
const STRENGTH_GLOBAL_RX = /(\d+(?:\.\d+)?)\s*mg\s*\/\s*(\d+(?:\.\d+)?)?\s*ml\b/gi;

function parseStrengthMgPerMl(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(STRENGTH_RX);
  if (!m) return null;
  const mg = Number.parseFloat(m[1]);
  const perMl = m[2] != null && m[2] !== '' ? Number.parseFloat(m[2]) : 1;
  if (!Number.isFinite(mg) || !Number.isFinite(perMl) || perMl <= 0 || mg <= 0) return null;
  return mg / perMl;
}

function parseMgPerKgDose(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(MG_PER_KG_RX);
  if (!m) return null;
  const mgPerKg = Number.parseFloat(m[1]);
  return Number.isFinite(mgPerKg) && mgPerKg > 0 ? mgPerKg : null;
}

function stripStrengthTokens(text) {
  return String(text || '').replace(STRENGTH_GLOBAL_RX, ' ');
}

function parseDoseToMg(doseString, options = {}) {
  if (!doseString || typeof doseString !== 'string') return null;
  const mgPerKg = parseMgPerKgDose(doseString);
  if (mgPerKg !== null) {
    const weightKg = Number(options.weightKg);
    if (Number.isFinite(weightKg) && weightKg > 0) return mgPerKg * weightKg;
  }

  // Remove syrup-strength and mg/kg tokens before looking for a literal dose.
  // Otherwise "15 mg/kg" is misread as a flat 15 mg dose, and
  // "125 mg/5 ml syrup" is misread as a flat 125 mg dose.
  const doseText = stripStrengthTokens(doseString).replace(MG_PER_KG_GLOBAL_RX, ' ');
  const m = doseText.match(DOSE_VALUE_RX);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit === 'mg') return value;
  if (unit === 'g') return value * 1000;
  if (unit === 'mcg' || unit === 'µg') return value / 1000;
  // ml is liquid volume — needs a strength (e.g. "125mg/5ml") to
  // convert. When the caller passes a strengthMgPerMl (parsed from the
  // medication name or an explicit field), we do the conversion here;
  // otherwise return null so the dose check skips silently. Finding:
  // 2026-05-10-pediatric-opd-doctor-syrup-volume-dose-bypass.
  if (unit === 'ml' && Number.isFinite(options.strengthMgPerMl) && options.strengthMgPerMl > 0) {
    return value * options.strengthMgPerMl;
  }
  return null;
}

function findLiquidDoseMismatch(doseString, strengthMgPerMl, options = {}) {
  if (!doseString || typeof doseString !== 'string') return null;
  if (!Number.isFinite(strengthMgPerMl) || strengthMgPerMl <= 0) return null;
  const doseWithoutStrength = stripStrengthTokens(doseString);
  const tokens = [];
  for (const match of doseWithoutStrength.matchAll(DOSE_VALUE_GLOBAL_RX)) {
    const value = Number.parseFloat(match[1]);
    const unit = String(match[2] || '').toLowerCase();
    if (Number.isFinite(value) && value > 0) tokens.push({ value, unit });
  }
  const absoluteDoseText = doseWithoutStrength.replace(MG_PER_KG_GLOBAL_RX, ' ');
  const absoluteTokens = [];
  for (const match of absoluteDoseText.matchAll(DOSE_VALUE_GLOBAL_RX)) {
    const value = Number.parseFloat(match[1]);
    const unit = String(match[2] || '').toLowerCase();
    if (Number.isFinite(value) && value > 0) absoluteTokens.push({ value, unit });
  }
  const mgPerKg = parseMgPerKgDose(doseWithoutStrength);
  const weightKg = Number(options.weightKg);
  const enteredMg = mgPerKg !== null && Number.isFinite(weightKg) && weightKg > 0
    ? mgPerKg * weightKg
    : absoluteTokens.find((t) => t.unit === 'mg')?.value;
  const mlToken = tokens.find((t) => t.unit === 'ml');
  if (!enteredMg || !mlToken) return null;
  const expectedMl = enteredMg / strengthMgPerMl;
  const expectedMg = mlToken.value * strengthMgPerMl;
  const mlTolerance = Math.max(0.1, expectedMl * 0.05);
  if (Math.abs(mlToken.value - expectedMl) <= mlTolerance) return null;
  return {
    entered_mg: Number(enteredMg.toFixed(2)),
    entered_ml: mlToken.value,
    strength_mg_per_ml: strengthMgPerMl,
    expected_ml: Number(expectedMl.toFixed(2)),
    expected_mg_for_entered_ml: Number(expectedMg.toFixed(2)),
  };
}

function findMgPerKg(medName) {
  const name = String(medName || '').toLowerCase();
  for (const [drug, mgPerKg] of Object.entries(PAEDIATRIC_MG_PER_KG)) {
    if (name.includes(drug)) return { drug, mgPerKg };
  }
  return null;
}

// Loud-but-honest allergy phrasing seen in clinician free-text notes.
// "Allergy: Penicillin", "Allergies — Sulfa, NSAIDs", "Pt allergic to
// peanuts". The trailing list is captured up to the next sentence
// terminator so multi-allergen lines split cleanly downstream.
const NOTE_ALLERGY_RX = /(?:allergy|allergies|allergic\s+to)\s*[-:–]?\s*([A-Za-z][A-Za-z0-9 ,/-]{1,120})/gi;

const ALLERGY_LIST_SPLIT_RX = /[,;/]| and /i;

// Beta-lactam cross-reactivity — penicillin-class allergy implies
// caution on any beta-lactam. Substring match (no regex anchors) so
// brand names like "amoxiclav" / "augmentin" still hit.
const BETA_LACTAM_DRUGS = [
  'penicillin', 'amoxicillin', 'ampicillin', 'piperacillin',
  'cloxacillin', 'flucloxacillin', 'methicillin', 'augmentin',
  'amoxiclav', 'tazobactam',
];
const BETA_LACTAM_ALLERGENS = ['penicillin', 'amoxicillin', 'beta-lactam', 'beta lactam'];

function extractAllergiesFromNote(text) {
  if (!text || typeof text !== 'string') return [];
  const found = new Set();
  for (const match of text.matchAll(NOTE_ALLERGY_RX)) {
    const raw = (match[1] || '').trim();
    if (!raw) continue;
    for (const piece of raw.split(ALLERGY_LIST_SPLIT_RX)) {
      const cleaned = piece
        .replace(/[.\s]+$/, '')
        .trim()
        .toLowerCase();
      // Drop common false-positive trailing words (one-word stopwords)
      // and require ≥3 chars so "no", "an", "to" never become an allergen.
      if (cleaned.length >= 3 && !/^(none|nil|nka|nkda|known|reported)$/.test(cleaned)) {
        found.add(cleaned);
      }
    }
  }
  return [...found];
}

function medicationConflictsWithAllergen(medName, allergen) {
  const med = String(medName || '').toLowerCase();
  const allergy = String(allergen || '').toLowerCase();
  if (!med || !allergy) return false;
  if (med.includes(allergy) || allergy.includes(med)) return true;
  // Beta-lactam cross-reactivity (penicillin allergy ↔ amoxicillin etc.)
  const allergyIsBetaLactam = BETA_LACTAM_ALLERGENS.some((a) => allergy.includes(a));
  if (allergyIsBetaLactam && BETA_LACTAM_DRUGS.some((d) => med.includes(d))) return true;
  return false;
}

/**
 * Best-effort patient context lookup for paediatric weight-based dosing.
 * Reads age (DOB) + most-recent recorded weight. Returns null if either
 * piece is missing — the dose check then silently skips for this patient
 * rather than 500'ing or false-flagging.
 */
async function loadPaediatricContext(patientId) {
  if (!patientId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         CASE WHEN birthday IS NOT NULL THEN
           DATE_PART('year', AGE(NOW()::date, birthday))::int
         ELSE NULL END AS age_years
       FROM users WHERE id = $1 LIMIT 1`,
      patientId,
    );
    const ageYears = rows[0]?.age_years ?? null;
    if (ageYears === null || ageYears >= 12) return null; // Not paediatric
    // Most recent recorded weight from vitals_chart (joined via patient_uid).
    // This won't fire for patients we never recorded vitals on; that's OK,
    // dose check just skips silently in that case.
    const weightRows = await prisma.$queryRawUnsafe(
      `SELECT vc.weight_kg
         FROM vitals_chart vc
         JOIN users u ON u.uid = vc.patient_uid
        WHERE u.id = $1 AND vc.weight_kg IS NOT NULL
        ORDER BY vc.recorded_at DESC NULLS LAST LIMIT 1`,
      patientId,
    );
    const weightKg = weightRows[0]?.weight_kg ? Number(weightRows[0].weight_kg) : null;
    if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
    return { ageYears, weightKg };
  } catch (err) {
    logger.warn(`prescriptionSafetyCheck: paediatric context lookup failed for patient=${patientId}: ${err.message}`);
    return null;
  }
}

/**
 * Antithrombotic drug classes for bleeding-risk interaction screening.
 * Generic names plus the common brand names seen on Indian prescriptions
 * (the platform is ABDM / India-first), matched case-insensitive
 * substring against the medication name — same approach as
 * PAEDIATRIC_MG_PER_KG and BETA_LACTAM_DRUGS above.
 *
 * This is a curated, well-attested table, NOT a general drug-interaction
 * engine. Scope is deliberately limited to the bleeding-risk
 * antithrombotic class flagged in finding
 * 2026-05-10-emergency-walk-in-doctor-safety-check-misses-dapt-anticoag-bleeding-risk.
 * Where it is uncertain whether a drug belongs in a class, it is left
 * out rather than guessed.
 *
 *  - antiplatelet:  aspirin + the P2Y12 inhibitors (clopidogrel,
 *                   ticagrelor, prasugrel)
 *  - anticoagulant: vitamin-K antagonist (warfarin), heparins
 *                   (unfractionated heparin, enoxaparin LMWH), and the
 *                   DOACs apixaban / rivaroxaban / dabigatran
 *  - nsaid:         non-selective NSAIDs — not antithrombotics
 *                   themselves, but well-attested amplifiers of
 *                   anticoagulant bleeding risk (platelet inhibition +
 *                   GI mucosal injury)
 *
 * Aspirin is classed antiplatelet only (its role at the cardiac /
 * secondary-prevention doses these rules target), never nsaid, so every
 * drug maps to exactly one class.
 */
const ANTITHROMBOTIC_DRUGS = [
  // Antiplatelets
  { generic: 'aspirin', klass: 'antiplatelet', aliases: ['aspirin', 'acetylsalicylic', 'ecosprin', 'disprin'] },
  { generic: 'clopidogrel', klass: 'antiplatelet', aliases: ['clopidogrel', 'plavix', 'clopilet', 'deplatt'] },
  { generic: 'ticagrelor', klass: 'antiplatelet', aliases: ['ticagrelor', 'brilinta'] },
  { generic: 'prasugrel', klass: 'antiplatelet', aliases: ['prasugrel', 'effient'] },
  // Anticoagulants
  { generic: 'warfarin', klass: 'anticoagulant', aliases: ['warfarin', 'coumadin'] },
  { generic: 'enoxaparin', klass: 'anticoagulant', aliases: ['enoxaparin', 'clexane', 'lovenox'] },
  { generic: 'heparin', klass: 'anticoagulant', aliases: ['heparin'] },
  { generic: 'apixaban', klass: 'anticoagulant', aliases: ['apixaban', 'eliquis'] },
  { generic: 'rivaroxaban', klass: 'anticoagulant', aliases: ['rivaroxaban', 'xarelto'] },
  { generic: 'dabigatran', klass: 'anticoagulant', aliases: ['dabigatran', 'pradaxa'] },
  // NSAIDs — bleeding-risk amplifiers
  { generic: 'ibuprofen', klass: 'nsaid', aliases: ['ibuprofen', 'brufen'] },
  { generic: 'naproxen', klass: 'nsaid', aliases: ['naproxen'] },
  { generic: 'diclofenac', klass: 'nsaid', aliases: ['diclofenac', 'voveran'] },
  { generic: 'aceclofenac', klass: 'nsaid', aliases: ['aceclofenac'] },
  { generic: 'ketorolac', klass: 'nsaid', aliases: ['ketorolac'] },
  { generic: 'indomethacin', klass: 'nsaid', aliases: ['indomethacin'] },
  { generic: 'mefenamic', klass: 'nsaid', aliases: ['mefenamic'] },
  { generic: 'piroxicam', klass: 'nsaid', aliases: ['piroxicam'] },
];

const PREGNANCY_HIGH_RISK_DRUGS = [
  {
    term: 'isotretinoin',
    severity: 'HIGH',
    message: 'Isotretinoin is contraindicated in pregnancy. Confirm pregnancy status and use only through a documented specialist pathway.',
  },
  {
    term: 'methotrexate',
    severity: 'HIGH',
    message: 'Methotrexate is contraindicated in pregnancy unless being used in a specific obstetric emergency protocol.',
  },
  {
    term: 'misoprostol',
    severity: 'HIGH',
    message: 'Misoprostol has pregnancy-specific indications and risks. Confirm indication, gestation, and documented consent.',
  },
  {
    term: 'warfarin',
    severity: 'HIGH',
    message: 'Warfarin is generally avoided in pregnancy because of fetal risk. Confirm indication and specialist plan before prescribing.',
  },
  {
    term: 'valproate',
    severity: 'HIGH',
    message: 'Valproate carries major fetal risk. Confirm pregnancy status, contraception counselling, and specialist indication.',
  },
  {
    term: 'atorvastatin',
    severity: 'MODERATE',
    message: 'Statins are usually withheld in pregnancy. Confirm pregnancy status and indication before continuing.',
  },
  {
    term: 'rosuvastatin',
    severity: 'MODERATE',
    message: 'Statins are usually withheld in pregnancy. Confirm pregnancy status and indication before continuing.',
  },
  {
    term: 'simvastatin',
    severity: 'MODERATE',
    message: 'Statins are usually withheld in pregnancy. Confirm pregnancy status and indication before continuing.',
  },
  {
    term: 'enalapril',
    severity: 'HIGH',
    message: 'ACE inhibitors are contraindicated later in pregnancy and need obstetric review.',
  },
  {
    term: 'ramipril',
    severity: 'HIGH',
    message: 'ACE inhibitors are contraindicated later in pregnancy and need obstetric review.',
  },
  {
    term: 'lisinopril',
    severity: 'HIGH',
    message: 'ACE inhibitors are contraindicated later in pregnancy and need obstetric review.',
  },
  {
    term: 'losartan',
    severity: 'HIGH',
    message: 'ARBs are contraindicated later in pregnancy and need obstetric review.',
  },
  {
    term: 'telmisartan',
    severity: 'HIGH',
    message: 'ARBs are contraindicated later in pregnancy and need obstetric review.',
  },
  {
    term: 'olmesartan',
    severity: 'HIGH',
    message: 'ARBs are contraindicated later in pregnancy and need obstetric review.',
  },
  {
    term: 'doxycycline',
    severity: 'MODERATE',
    message: 'Tetracyclines are generally avoided in pregnancy. Confirm indication and safer alternatives.',
  },
  {
    term: 'tetracycline',
    severity: 'MODERATE',
    message: 'Tetracyclines are generally avoided in pregnancy. Confirm indication and safer alternatives.',
  },
];

const RENAL_RISK_DRUGS = [
  { term: 'ibuprofen', severity: 'MODERATE', message: 'NSAIDs can worsen renal function. Confirm latest creatinine/eGFR and hydration status.' },
  { term: 'diclofenac', severity: 'MODERATE', message: 'NSAIDs can worsen renal function. Confirm latest creatinine/eGFR and hydration status.' },
  { term: 'aceclofenac', severity: 'MODERATE', message: 'NSAIDs can worsen renal function. Confirm latest creatinine/eGFR and hydration status.' },
  { term: 'naproxen', severity: 'MODERATE', message: 'NSAIDs can worsen renal function. Confirm latest creatinine/eGFR and hydration status.' },
  { term: 'ketorolac', severity: 'HIGH', message: 'Ketorolac is high renal/GI risk. Avoid or document strong indication with renal review.' },
  { term: 'gentamicin', severity: 'HIGH', message: 'Aminoglycosides require renal-adjusted dosing and monitoring.' },
  { term: 'amikacin', severity: 'HIGH', message: 'Aminoglycosides require renal-adjusted dosing and monitoring.' },
  { term: 'vancomycin', severity: 'MODERATE', message: 'Vancomycin requires renal dosing review and trough/level monitoring.' },
  { term: 'metformin', severity: 'HIGH', message: 'Metformin needs renal-function review; avoid in severe renal impairment or acute illness.' },
  { term: 'nitrofurantoin', severity: 'HIGH', message: 'Nitrofurantoin is usually avoided when eGFR is low. Confirm renal function.' },
  { term: 'spironolactone', severity: 'MODERATE', message: 'Spironolactone can worsen hyperkalaemia in renal impairment. Confirm K+/creatinine.' },
  { term: 'furosemide', severity: 'MODERATE', message: 'Loop diuretic dosing should be reviewed against renal function and volume status.' },
];

const ANTIBIOTIC_RULES = [
  { term: 'amoxicillin', className: 'penicillin', reserve: false },
  { term: 'amoxiclav', className: 'penicillin-beta-lactamase-inhibitor', reserve: false },
  { term: 'augmentin', className: 'penicillin-beta-lactamase-inhibitor', reserve: false },
  { term: 'piperacillin', className: 'anti-pseudomonal-beta-lactam', reserve: true },
  { term: 'tazobactam', className: 'anti-pseudomonal-beta-lactam', reserve: true },
  { term: 'ceftriaxone', className: 'cephalosporin', reserve: false },
  { term: 'cefixime', className: 'cephalosporin', reserve: false },
  { term: 'cefoperazone', className: 'broad-spectrum-cephalosporin', reserve: true },
  { term: 'meropenem', className: 'carbapenem', reserve: true },
  { term: 'imipenem', className: 'carbapenem', reserve: true },
  { term: 'ertapenem', className: 'carbapenem', reserve: true },
  { term: 'vancomycin', className: 'glycopeptide', reserve: true },
  { term: 'teicoplanin', className: 'glycopeptide', reserve: true },
  { term: 'linezolid', className: 'oxazolidinone', reserve: true },
  { term: 'colistin', className: 'polymyxin', reserve: true },
  { term: 'polymyxin', className: 'polymyxin', reserve: true },
  { term: 'tigecycline', className: 'glycylcycline', reserve: true },
  { term: 'azithromycin', className: 'macrolide', reserve: false },
  { term: 'clarithromycin', className: 'macrolide', reserve: false },
  { term: 'ciprofloxacin', className: 'fluoroquinolone', reserve: false },
  { term: 'levofloxacin', className: 'fluoroquinolone', reserve: false },
  { term: 'moxifloxacin', className: 'fluoroquinolone', reserve: false },
  { term: 'doxycycline', className: 'tetracycline', reserve: false },
  { term: 'metronidazole', className: 'nitroimidazole', reserve: false },
  { term: 'clindamycin', className: 'lincosamide', reserve: false },
  { term: 'gentamicin', className: 'aminoglycoside', reserve: false },
  { term: 'amikacin', className: 'aminoglycoside', reserve: false },
];

function classifyAntithromboticDrug(medName) {
  const name = String(medName || '').toLowerCase();
  if (!name) return null;
  for (const entry of ANTITHROMBOTIC_DRUGS) {
    if (entry.aliases.some((alias) => name.includes(alias))) {
      return { generic: entry.generic, klass: entry.klass };
    }
  }
  return null;
}

function medicationDisplayName(med) {
  return String(med?.name || med?.medication_name || med?.drug_name || '').trim();
}

function medicationSearchText(med) {
  return [
    med?.name,
    med?.medication_name,
    med?.drug_name,
    med?.generic_name,
    med?.strength,
    med?.dose,
    med?.dosage,
  ].filter(Boolean).join(' ').toLowerCase();
}

function medIncludes(med, term) {
  return medicationSearchText(med).includes(String(term || '').toLowerCase());
}

function parseMedicationDays(med) {
  const value = med?.days ?? med?.duration_days ?? med?.duration;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const m = String(value || '').match(/\d+/);
  if (!m) return null;
  const days = Number.parseInt(m[0], 10);
  return Number.isInteger(days) && days > 0 ? days : null;
}

async function loadPregnancyContext(patientId) {
  if (!patientId) return { activePregnancy: false, possiblePregnancy: false };
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT u.gender,
              u.is_pregnant,
              u.pregnancy_lmp_date,
              CASE WHEN u.birthday IS NOT NULL THEN DATE_PART('year', AGE(NOW()::date, u.birthday))::int ELSE NULL END AS age_years,
              EXISTS (
                SELECT 1 FROM maternity_pregnancies mp
                 WHERE mp.patient_uid = u.uid
                   AND COALESCE(mp.status, 'ongoing') = 'ongoing'
              ) AS has_ongoing_pregnancy
         FROM users u
        WHERE u.id = $1
        LIMIT 1`,
      patientId,
    );
    const row = rows[0] || {};
    const gender = String(row.gender || '').toLowerCase();
    const age = row.age_years == null ? null : Number(row.age_years);
    const possiblePregnancy = ['female', 'f'].includes(gender) && (age == null || (age >= 10 && age <= 55));
    return {
      activePregnancy: Boolean(row.is_pregnant || row.has_ongoing_pregnancy),
      possiblePregnancy,
      ageYears: age,
      lmpDate: row.pregnancy_lmp_date || null,
    };
  } catch (err) {
    logger.warn(`prescriptionSafetyCheck: pregnancy context lookup failed for patient=${patientId}: ${err.message}`);
    return { activePregnancy: false, possiblePregnancy: false };
  }
}

async function loadRenalContext(patientId) {
  if (!patientId) return { evidenceFound: false };
  try {
    const rows = await prisma.$queryRawUnsafe(
      `WITH patient AS (
         SELECT id, uid FROM users WHERE id = $1 LIMIT 1
       ),
       recent_labs AS (
         SELECT test_name, test_code, value_numeric, value_text, unit, received_at
           FROM lab_results lr
           JOIN patient p ON p.uid = lr.patient_uid
          WHERE (
                 lr.test_name ILIKE '%egfr%'
              OR lr.test_code ILIKE '%egfr%'
              OR lr.test_name ILIKE '%creatinine%'
              OR lr.test_code ILIKE '%creat%'
              OR lr.test_name ILIKE '%urea%'
              OR lr.test_code ILIKE '%urea%'
            )
          ORDER BY lr.received_at DESC NULLS LAST
          LIMIT 8
       )
       SELECT jsonb_agg(
                jsonb_build_object(
                  'test_name', test_name,
                  'test_code', test_code,
                  'value_numeric', value_numeric,
                  'value_text', value_text,
                  'unit', unit,
                  'received_at', received_at
                )
              ) AS labs
          FROM recent_labs`,
      patientId,
    );
    const labs = Array.isArray(rows[0]?.labs) ? rows[0].labs : [];
    const egfr = labs
      .filter((r) => /egfr|e-gfr/i.test(`${r.test_name || ''} ${r.test_code || ''}`))
      .map((r) => Number(r.value_numeric ?? r.value_text))
      .find((v) => Number.isFinite(v));
    const creatinine = labs
      .filter((r) => /creatinine|creat/i.test(`${r.test_name || ''} ${r.test_code || ''}`))
      .map((r) => Number(r.value_numeric ?? r.value_text))
      .find((v) => Number.isFinite(v));
    return {
      evidenceFound: labs.length > 0,
      egfr: Number.isFinite(egfr) ? egfr : null,
      creatinine: Number.isFinite(creatinine) ? creatinine : null,
      impaired: (Number.isFinite(egfr) && egfr < 60) || (Number.isFinite(creatinine) && creatinine >= 1.5),
      severe: (Number.isFinite(egfr) && egfr < 30) || (Number.isFinite(creatinine) && creatinine >= 2.5),
      labs: labs.slice(0, 4),
    };
  } catch (err) {
    logger.warn(`prescriptionSafetyCheck: renal context lookup failed for patient=${patientId}: ${err.message}`);
    return { evidenceFound: false };
  }
}

function checkPregnancyMedicationSafety(medications, context) {
  const warnings = [];
  const blockers = [];
  if (!Array.isArray(medications) || !context) return { warnings, blockers };

  for (const med of medications) {
    const name = medicationDisplayName(med);
    if (!name) continue;
    for (const rule of PREGNANCY_HIGH_RISK_DRUGS) {
      if (!medIncludes(med, rule.term)) continue;
      const issue = {
        type: context.activePregnancy ? 'PREGNANCY_MEDICATION_RISK' : 'PREGNANCY_STATUS_REVIEW',
        medication: name,
        severity: rule.severity,
        message: context.activePregnancy
          ? rule.message
          : `${name} can be pregnancy-sensitive. Confirm pregnancy status before prescribing to a patient of reproductive age.`,
      };
      if (context.activePregnancy && rule.severity === 'HIGH') blockers.push(issue);
      else if (context.activePregnancy || context.possiblePregnancy) warnings.push(issue);
    }
  }

  return { warnings, blockers };
}

function checkRenalMedicationSafety(medications, context) {
  const warnings = [];
  const blockers = [];
  if (!Array.isArray(medications) || !context) return { warnings, blockers };

  for (const med of medications) {
    const name = medicationDisplayName(med);
    if (!name) continue;
    for (const rule of RENAL_RISK_DRUGS) {
      if (!medIncludes(med, rule.term)) continue;
      const issue = {
        type: context.evidenceFound ? 'RENAL_MEDICATION_REVIEW' : 'RENAL_EVIDENCE_MISSING',
        medication: name,
        severity: rule.severity,
        latest_egfr: context.egfr ?? null,
        latest_creatinine: context.creatinine ?? null,
        message: context.evidenceFound
          ? rule.message
          : `${name} may require renal review. No recent creatinine/eGFR was found in the lab-result feed.`,
      };
      if (context.severe && rule.severity === 'HIGH') blockers.push(issue);
      else warnings.push(issue);
    }
  }

  return { warnings, blockers };
}

function classifyAntibiotic(med) {
  for (const rule of ANTIBIOTIC_RULES) {
    if (medIncludes(med, rule.term)) return rule;
  }
  return null;
}

function checkAntibioticStewardship(medications) {
  const warnings = [];
  if (!Array.isArray(medications)) return { warnings, blockers: [] };

  const antibiotics = medications
    .map((med) => ({ med, name: medicationDisplayName(med), rule: classifyAntibiotic(med) }))
    .filter((entry) => entry.name && entry.rule);

  for (const entry of antibiotics) {
    const days = parseMedicationDays(entry.med);
    if (!days) {
      warnings.push({
        type: 'ANTIBIOTIC_DURATION_MISSING',
        medication: entry.name,
        severity: 'MODERATE',
        message: `${entry.name} appears to be an antibiotic. Add intended duration/days and review stop date.`,
      });
    } else if (days > 14) {
      warnings.push({
        type: 'ANTIBIOTIC_LONG_DURATION',
        medication: entry.name,
        severity: 'MODERATE',
        duration_days: days,
        message: `${entry.name} duration is ${days} days. Confirm indication and review/de-escalation plan.`,
      });
    }
    if (entry.rule.reserve) {
      warnings.push({
        type: 'ANTIBIOTIC_STEWARDSHIP_RESERVE',
        medication: entry.name,
        class_name: entry.rule.className,
        severity: 'HIGH',
        message: `${entry.name} is a broad/reserve antibiotic. Document indication, culture plan, and de-escalation review.`,
      });
    }
  }

  const classBuckets = new Map();
  for (const entry of antibiotics) {
    const bucket = classBuckets.get(entry.rule.className) || [];
    bucket.push(entry.name);
    classBuckets.set(entry.rule.className, bucket);
  }
  for (const [className, names] of classBuckets.entries()) {
    const uniqueNames = [...new Set(names.map((n) => n.toLowerCase()))];
    if (uniqueNames.length > 1) {
      warnings.push({
        type: 'ANTIBIOTIC_DUPLICATE_SPECTRUM',
        class_name: className,
        medications: [...new Set(names)],
        severity: 'MODERATE',
        message: `Multiple antibiotics from the ${className} spectrum are prescribed together. Confirm combination rationale.`,
      });
    }
  }

  return { warnings, blockers: [] };
}

/**
 * Screen a medication list for bleeding-risk antithrombotic interactions.
 * Pure function — no DB, no patient context — so it is unit-testable in
 * isolation. Returns the same { warnings, blockers } issue shape the
 * allergy / duplicate / paediatric-dose checks use.
 *
 * Clinically-attested rules (bleeding-risk antithrombotic class only):
 *   1. Two or more antiplatelets — dual antiplatelet therapy (DAPT) → WARNING
 *   2. Antiplatelet + anticoagulant                                → BLOCKER
 *   3. DAPT + anticoagulant ("triple therapy")                     → BLOCKER
 *   4. Anticoagulant + NSAID                                       → WARNING
 *
 * Concurrent antithrombotics multiply bleeding risk: adding an
 * antiplatelet to an anticoagulant roughly doubles the major-bleeding
 * rate, and "triple therapy" (DAPT + anticoagulant) carries the highest
 * bleeding risk of any antithrombotic combination — ESC/ACC guidance
 * caps its duration for exactly that reason. NSAIDs amplify
 * anticoagulant bleeding risk via platelet inhibition and GI mucosal
 * injury. Per the finding above and standard antithrombotic-stewardship
 * practice, antiplatelet+anticoagulant and triple therapy are hard
 * blockers: the prescriber can still proceed for a genuine indication
 * (NSTEMI, mechanical valve + ACS, etc.) through the same
 * override-with-reason path createPrescription already enforces for the
 * allergy / paediatric-dose blockers.
 *
 * @param {Array} medications - [{ name | medication_name, ... }]
 * @returns {{ warnings: Array, blockers: Array }}
 */
export function checkAntithromboticInteractions(medications) {
  const warnings = [];
  const blockers = [];
  if (!Array.isArray(medications)) return { warnings, blockers };

  const antiplatelets = [];
  const anticoagulants = [];
  const nsaids = [];
  for (const med of medications) {
    const name = med?.name || med?.medication_name || '';
    const hit = classifyAntithromboticDrug(name);
    if (!hit) continue;
    if (hit.klass === 'antiplatelet') antiplatelets.push(name);
    else if (hit.klass === 'anticoagulant') anticoagulants.push(name);
    else if (hit.klass === 'nsaid') nsaids.push(name);
  }

  const hasDapt = antiplatelets.length >= 2;
  const hasAntiplatelet = antiplatelets.length >= 1;
  const hasAnticoagulant = anticoagulants.length >= 1;

  // The antiplatelet-axis rules are mutually exclusive and ordered by
  // severity — triple therapy subsumes both DAPT and the lone
  // antiplatelet+anticoagulant pairing, so only the most severe fires.
  if (hasDapt && hasAnticoagulant) {
    blockers.push({
      type: 'ANTITHROMBOTIC_INTERACTION',
      interaction: 'TRIPLE_THERAPY',
      severity: 'HIGH',
      medications: [...antiplatelets, ...anticoagulants],
      message:
        `Triple antithrombotic therapy — dual antiplatelets (${antiplatelets.join(', ')}) `
        + `combined with anticoagulant (${anticoagulants.join(', ')}) carry the highest bleeding `
        + 'risk of any antithrombotic combination. Confirm the indication and minimum duration, '
        + 'or override with reason.',
    });
  } else if (hasAntiplatelet && hasAnticoagulant) {
    blockers.push({
      type: 'ANTITHROMBOTIC_INTERACTION',
      interaction: 'ANTIPLATELET_ANTICOAGULANT',
      severity: 'HIGH',
      medications: [...antiplatelets, ...anticoagulants],
      message:
        `Antiplatelet (${antiplatelets.join(', ')}) combined with anticoagulant `
        + `(${anticoagulants.join(', ')}) — high bleeding risk. Confirm the indication, `
        + 'or override with reason.',
    });
  } else if (hasDapt) {
    warnings.push({
      type: 'ANTITHROMBOTIC_INTERACTION',
      interaction: 'DUAL_ANTIPLATELET',
      severity: 'MODERATE',
      medications: [...antiplatelets],
      message:
        `Dual antiplatelet therapy (${antiplatelets.join(', ')}) — increased bleeding risk. `
        + 'Expected after ACS or stent placement; confirm the indication and planned duration.',
    });
  }

  // The NSAID rule is orthogonal to the antiplatelet axis above — a
  // triple-therapy patient who is also on an NSAID gets both findings.
  if (hasAnticoagulant && nsaids.length >= 1) {
    warnings.push({
      type: 'ANTITHROMBOTIC_INTERACTION',
      interaction: 'ANTICOAGULANT_NSAID',
      severity: 'MODERATE',
      medications: [...anticoagulants, ...nsaids],
      message:
        `NSAID (${nsaids.join(', ')}) with anticoagulant (${anticoagulants.join(', ')}) — `
        + 'NSAIDs amplify anticoagulant bleeding risk via platelet inhibition and GI mucosal '
        + 'injury. Prefer paracetamol; if an NSAID is clinically required, add gastroprotection '
        + 'and monitor.',
    });
  }

  return { warnings, blockers };
}

/**
 * Validate a prescription against patient allergies and active medications.
 * Call before saving any new prescription.
 * @param {number} patientId
 * @param {Array} medications - [{ medication_id, name, ... }]
 * @returns {{ safe: boolean, warnings: Array, blockers: Array }}
 */
export async function validatePrescriptionSafety(patientId, medications) {
  const warnings = [];
  const blockers = [];

  try {
    // 1. Check patient allergies — ALL stores (roadmap A10). The old query
    // read patient_allergies by patient_id only, so it missed: uid-keyed
    // patient_allergies rows, the legacy `allergies` import table (written
    // by patientDataImport, previously read only by CCDA/FHIR exporters),
    // the users.allergies profile text, and admission-intake allergies.
    // getUnifiedActiveAllergies unions all four, dedupes case-insensitively
    // keeping the highest severity, and never throws.
    const allergies = await getUnifiedActiveAllergies(prisma, { patientId });

    if (allergies.length > 0) {
      for (const med of medications) {
        const medName = (med.name || med.medication_name || '').toLowerCase();
        // Skip medication lines with no resolvable name: an empty medName makes
        // `allergyName.includes(medName)` (empty-substring) always true, which would
        // spuriously match EVERY recorded allergy and emit a bogus ALLERGY_CONFLICT —
        // a false HARD BLOCKER if any allergy is severe. Mirrors the display-name
        // guard the other safety checks (pregnancy/renal/stewardship/paediatric) use.
        if (!medName) continue;
        for (const allergy of allergies) {
          const allergyName = (allergy.allergen || '').toLowerCase();
          // Simple substring match — production should use a proper drug-allergy database
          if (allergyName && (medName.includes(allergyName) || allergyName.includes(medName))) {
            const issue = {
              type: 'ALLERGY_CONFLICT',
              medication: med.name || med.medication_name,
              allergy: allergy.allergen,
              severity: allergy.severity || 'UNKNOWN',
              sources: allergy.sources,
              message: `Patient is allergic to "${allergy.allergen}" — "${med.name || med.medication_name}" may cause a reaction`,
            };
            // Rank-based gate (fail-safe): SEVERE/CONTRAINDICATED and above are
            // hard blockers; a present-but-unrecognized severity ranks as SEVERE
            // so a documented allergy is never silently downgraded to a warning
            // because its label wasn't in a hardcoded set (audit §3).
            if (rankSeverity(allergy.severity) >= SEVERE_BLOCK_RANK) {
              blockers.push(issue);
            } else {
              warnings.push(issue);
            }
          }
        }
      }
    }

    // 1b. Unstructured allergy scan. Doctors routinely write "Allergy:
    //     Penicillin" in the appointment note instead of (or before)
    //     adding a structured patient_allergies row. The structured-only
    //     check above misses the allergen entirely and reports the
    //     beta-lactam prescription as safe — clinical-safety failure.
    //     Scan recent free-text notes for the patient and treat any
    //     extracted allergen as a blocker (severity UNSTRUCTURED), with
    //     beta-lactam cross-reactivity wired in for the canonical
    //     penicillin→amoxicillin case. The override path remains
    //     available for cases where the note has been reviewed.
    //     Finding:
    //     2026-05-10-dynamic-acute-abdomen-doctor-allergy-safety-misses-penicillin.
    // Postgres requires per-source ORDER BY / LIMIT to live inside a
    // subquery — otherwise the parser treats the ORDER BY as applying to
    // the whole UNION and chokes on the next SELECT (`syntax error at or
    // near "UNION"`). Each side is wrapped in its own scalar subquery so
    // the 50-row cap is per-source.
    const noteRows = await prisma.$queryRawUnsafe(
      `SELECT source, body FROM (
         SELECT 'appointment' AS source,
                COALESCE(notes, '') || ' ' || COALESCE(reason, '') AS body,
                created_at
           FROM appointments
          WHERE patient_id = $1::int
            AND created_at >= NOW() - INTERVAL '365 days'
          ORDER BY created_at DESC
          LIMIT 50
       ) a
       UNION ALL
       SELECT source, body FROM (
         SELECT 'clinical_note' AS source, COALESCE(cn.notes, '') AS body
           FROM clinical_notes cn
           JOIN users u ON u.uid = cn.patient_uid
          WHERE u.id = $1::int
            AND cn.created_at >= NOW() - INTERVAL '365 days'
            AND COALESCE(cn.status, 'current') NOT IN ('superseded', 'deleted')
          ORDER BY cn.created_at DESC
          LIMIT 50
       ) c`,
      patientId,
    );

    const noteAllergens = new Set();
    for (const row of noteRows) {
      for (const allergen of extractAllergiesFromNote(row.body)) {
        noteAllergens.add(allergen);
      }
    }
    if (noteAllergens.size) {
      for (const med of medications) {
        const medName = med.name || med.medication_name || '';
        for (const allergen of noteAllergens) {
          // Skip if the structured check already produced a match for
          // this (medication, allergen) pair — avoid duplicate blockers.
          const alreadyFlagged = blockers.concat(warnings).some(
            (b) =>
              b.type === 'ALLERGY_CONFLICT' &&
              String(b.medication || '').toLowerCase() === medName.toLowerCase() &&
              String(b.allergy || '').toLowerCase() === allergen,
          );
          if (alreadyFlagged) continue;
          if (medicationConflictsWithAllergen(medName, allergen)) {
            blockers.push({
              type: 'ALLERGY_CONFLICT_UNSTRUCTURED',
              medication: medName,
              allergy: allergen,
              severity: 'UNSTRUCTURED',
              message: `Patient note records allergy "${allergen}" — "${medName}" may cause a reaction. Confirm and add a structured patient_allergies entry, or override with reason.`,
            });
          }
        }
      }
    }

    // 2. Check for duplicate active prescriptions (same medication)
    const activeMedsResult = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT
          COALESCE(
            NULLIF(TRIM(ep.medication_name), ''),
            NULLIF(TRIM(med.value->>'name'), ''),
            NULLIF(TRIM(med.value->>'medication_name'), '')
          ) AS medication_name
       FROM e_prescriptions ep
       LEFT JOIN LATERAL jsonb_array_elements(COALESCE(ep.medications, '[]'::jsonb)) AS med(value) ON TRUE
       WHERE ep.patient_id = $1
         AND LOWER(COALESCE(ep.status, 'active')) IN ('active', 'pharmacy_linked')
         AND (ep.follow_up_date IS NULL OR ep.follow_up_date >= CURRENT_DATE)`,
      patientId
    );

    for (const med of medications) {
      const medName = (med.name || med.medication_name || '').toLowerCase();
      for (const active of activeMedsResult) {
        if ((active.medication_name || '').toLowerCase() === medName) {
          warnings.push({
            type: 'DUPLICATE_MEDICATION',
            medication: med.name || med.medication_name,
            message: `"${med.name || med.medication_name}" is already actively prescribed to this patient`,
          });
        }
      }
    }

    // 3. Paediatric weight-based dose sanity check. Only fires for patients
    //    under 12 with a recorded weight; only checks drugs in the seed
    //    PAEDIATRIC_MG_PER_KG table. Anything outside that scope is
    //    silently skipped (no false positives, no false-confidence
    //    "all checked"). See finding
    //    2026-05-08-pediatric-opd-doctor-no-weight-based-dose-check.
    //
    //    A trigger (>1.2x weight-based ceiling) is now a HARD BLOCKER
    //    rather than a warning so the staff-app CDS modal forces the
    //    doctor to acknowledge with an override reason — adult-tablet
    //    doses for toddlers previously slipped through warnings-only.
    //    Override path is the same one the allergy blocker uses
    //    (`override: { reason: '...' }` on createPrescription, audited
    //    to prescription_safety_overrides). Findings:
    //      2026-05-09-pediatric-opd-doctor-paed-dose-warning-not-blocker
    //      2026-05-12-pediatric-opd-doctor-eba299c1
    const paedCtx = await loadPaediatricContext(patientId);
    if (paedCtx) {
      for (const med of medications) {
        const medName = med.name || med.medication_name || '';
        const mapping = findMgPerKg(medName);
        if (!mapping) continue;
        // Resolve syrup/drop strength so an ml-only dose can be converted
        // to mg. Priority: explicit strength_mg_per_ml field, then the
        // medication name (e.g. "Paracetamol syrup 125mg/5ml"), then the
        // strength / concentration free-text field if the doctor entered
        // one. Falls back to null → ml-only dose is skipped.
        const strengthMgPerMl =
          Number(med.strength_mg_per_ml) ||
          parseStrengthMgPerMl(medName) ||
          parseStrengthMgPerMl(med.strength) ||
          parseStrengthMgPerMl(med.concentration) ||
          null;
        const doseText = med.dose || med.dosage || '';
        const mismatch = findLiquidDoseMismatch(doseText, strengthMgPerMl, {
          weightKg: paedCtx.weightKg,
        });
        if (mismatch) {
          blockers.push({
            type: 'PAEDIATRIC_LIQUID_DOSE_MISMATCH',
            medication: medName,
            patient_weight_kg: paedCtx.weightKg,
            patient_age_years: paedCtx.ageYears,
            ...mismatch,
            message: `${medName} dose text says ${mismatch.entered_mg}mg and ${mismatch.entered_ml}ml, but the listed strength converts ${mismatch.entered_mg}mg to ${mismatch.expected_ml}ml. Correct the mg/ml instruction or override with reason.`,
          });
        }
        const doseMg = parseDoseToMg(doseText, {
          strengthMgPerMl,
          weightKg: paedCtx.weightKg,
        });
        if (doseMg === null) continue;
        const expectedMaxMg = mapping.mgPerKg * paedCtx.weightKg * 1.2; // 20% headroom
        if (doseMg > expectedMaxMg) {
          const ratio = (doseMg / (mapping.mgPerKg * paedCtx.weightKg)).toFixed(2);
          blockers.push({
            type: 'PAEDIATRIC_DOSE_HIGH',
            medication: medName,
            patient_weight_kg: paedCtx.weightKg,
            patient_age_years: paedCtx.ageYears,
            entered_dose_mg: doseMg,
            expected_max_per_dose_mg: Number(expectedMaxMg.toFixed(2)),
            mg_per_kg_reference: mapping.mgPerKg,
            strength_mg_per_ml: strengthMgPerMl,
            message: `${medName} ${doseMg}mg in a ${paedCtx.weightKg}kg ${paedCtx.ageYears}y patient is ${ratio}x the recommended ${mapping.mgPerKg}mg/kg per-dose ceiling. Confirm with weight-based dose, or override with reason.`,
          });
        }
      }
    }

    // 4. Antithrombotic (bleeding-risk) interaction screen. Pure, no DB —
    //    inspects the prescribed list itself for the well-attested
    //    bleeding-risk combinations the allergy / duplicate / dose checks
    //    above don't catch. Before this, aspirin + clopidogrel +
    //    enoxaparin (dual antiplatelet + anticoagulant) returned
    //    safe:true with zero warnings. Antiplatelet+anticoagulant and
    //    triple therapy land in blockers[] (override-with-reason via
    //    createPrescription); DAPT-alone and anticoagulant+NSAID are
    //    warnings. See finding
    //    2026-05-10-emergency-walk-in-doctor-safety-check-misses-dapt-anticoag-bleeding-risk.
    const antithrombotic = checkAntithromboticInteractions(medications);
    warnings.push(...antithrombotic.warnings);
    blockers.push(...antithrombotic.blockers);

    // 5. Pregnancy / lactation-adjacent medication safety. This is not a
    // complete teratogenicity database; it is a conservative first-trial
    // guard for the highest-signal drugs and ACEi/ARB/statin/tetracycline
    // classes. Active pregnancy + high-risk drug blocks until a clinician
    // overrides with reason; reproductive-age unknown status warns.
    const pregnancyContext = await loadPregnancyContext(patientId);
    const pregnancySafety = checkPregnancyMedicationSafety(medications, pregnancyContext);
    warnings.push(...pregnancySafety.warnings);
    blockers.push(...pregnancySafety.blockers);

    // 6. Renal dose / nephrotoxin review. When recent creatinine/eGFR is
    // present and severe, high-risk renal drugs block; otherwise they warn.
    // If no recent renal lab exists, renal-risk medicines warn so OPD can
    // order/check KFT instead of assuming safety.
    const renalContext = await loadRenalContext(patientId);
    const renalSafety = checkRenalMedicationSafety(medications, renalContext);
    warnings.push(...renalSafety.warnings);
    blockers.push(...renalSafety.blockers);

    // 7. Antibiotic stewardship: duration, reserve/broad-spectrum prompts,
    // and duplicate-spectrum prompts. These remain warnings because they
    // need clinical context, but they are visible before save and audited
    // through the existing override/lifecycle trail when overridden.
    const stewardship = checkAntibioticStewardship(medications);
    warnings.push(...stewardship.warnings);
    blockers.push(...stewardship.blockers);

    // 8. Drug knowledge base (roadmap B2). The general engine the checks
    //    above deliberately were not: drug–drug interactions, group-based
    //    allergy cross-sensitivity, drug–disease cautions against the B7
    //    problem list, dose ceilings (adult/renal), IV compatibility — all
    //    DB-backed (migration 277; licensed KB via drug-kb-import.mjs).
    //    The engine is schema-tolerant: on an un-migrated environment it
    //    reports kbAvailable:false and contributes nothing (the legacy
    //    checks above remain the safety floor). Severity mapping:
    //    contraindicated/major + same-class allergy hits → blockers
    //    (override-with-reason path unchanged), the rest → warnings.
    try {
      const patientRows = await prisma.$queryRawUnsafe(
        `SELECT uid,
                CASE WHEN birthday IS NOT NULL THEN DATE_PART('year', AGE(NOW()::date, birthday))::int
                     ELSE NULL END AS age_years
           FROM users WHERE id = $1 LIMIT 1`,
        patientId,
      );
      const patientUid = patientRows[0]?.uid || null;
      let activeProblems = [];
      if (patientUid) {
        try {
          activeProblems = await prisma.$queryRawUnsafe(
            `SELECT icd10_code, title FROM patient_problems
              WHERE patient_uid = $1::uuid AND status = 'active'`,
            patientUid,
          );
        } catch (problemErr) {
          if (!/does not exist/i.test(String(problemErr?.message || ''))) throw problemErr;
        }
      }
      const kbResult = await evaluateDrugKb({
        medications,
        allergies,
        problems: activeProblems,
        patient: {
          ageYears: patientRows[0]?.age_years ?? paedCtx?.ageYears ?? null,
          weightKg: paedCtx?.weightKg ?? null,
          egfr: renalContext?.egfr ?? null,
        },
      });
      for (const finding of kbResult.findings) {
        // The antithrombotic axis (check 4) owns its pairs — skip KB
        // duplicates where every involved drug classifies antithrombotic.
        if (finding.check === 'interaction'
          && finding.medications.every((name) => classifyAntithromboticDrug(name))) {
          continue;
        }
        // Skip cross-sensitivity findings already flagged by checks 1/1b
        // for the same medication+allergen pair.
        if (finding.check === 'allergy_cross_sensitivity') {
          const dup = blockers.concat(warnings).some(
            (b) => String(b.medication || '').toLowerCase() === String(finding.medications[0] || '').toLowerCase()
              && String(b.allergy || '').toLowerCase() === String(finding.allergen || '').toLowerCase()
              && (b.type === 'ALLERGY_CONFLICT' || b.type === 'ALLERGY_CONFLICT_UNSTRUCTURED'),
          );
          if (dup) continue;
        }
        const issue = {
          type: finding.check === 'interaction' ? 'DRUG_INTERACTION_KB'
            : finding.check === 'allergy_cross_sensitivity' ? 'ALLERGY_CROSS_SENSITIVITY_KB'
              : finding.check === 'condition_caution' ? 'DRUG_DISEASE_KB'
                : finding.check === 'dose_range' ? 'DOSE_RANGE_KB'
                  : 'IV_COMPATIBILITY_KB',
          severity: String(finding.severity || '').toUpperCase(),
          medication: finding.medications.join(' + '),
          medications: finding.medications,
          allergy: finding.allergen,
          message: finding.message,
          management: finding.management || null,
          kb_source: finding.source_key || null,
        };
        const blocking =
          (finding.check === 'interaction' && ['contraindicated', 'major'].includes(finding.severity))
          || (finding.check === 'allergy_cross_sensitivity' && finding.severity === 'high')
          || (finding.check === 'condition_caution' && finding.severity === 'contraindicated')
          || (finding.check === 'dose_range' && finding.severity === 'major');
        if (blocking) blockers.push(issue);
        else warnings.push(issue);
      }
    } catch (kbErr) {
      // KB evaluation must never weaken the floor checks above; treat an
      // unexpected KB failure as its own loud warning, not a silent pass
      // and not a full fail-closed (the deterministic checks already ran).
      logger.error('Drug KB evaluation failed (continuing with legacy checks):', kbErr.message);
      warnings.push({
        type: 'DRUG_KB_CHECK_ERROR',
        severity: 'MODERATE',
        message: 'Drug knowledge-base screening failed — interactions beyond the built-in checks were not evaluated this time.',
      });
    }

  } catch (err) {
    // Fail CLOSED on safety-check failure. Returning safe:true silently
    // allowed an allergy/dup-Rx lookup to be bypassed by triggering the
    // bug — a clinical-safety failure (CLAUDE.md: "Never return fake
    // success data in catch blocks"). The override path remains available
    // for cases where manual review has cleared the patient — callers
    // can pass an `override: { reason }` payload to createPrescription.
    // See finding 2026-05-08-pediatric-opd-doctor-cds-swallows-errors.
    logger.error('Prescription safety check failed (blocking prescription pending manual override):', err.message);
    blockers.push({
      type: 'SAFETY_CHECK_ERROR',
      message: 'Automated safety check failed — manual review and override required before prescribing.',
    });
    return { safe: false, warnings, blockers };
  }

  return {
    safe: blockers.length === 0,
    warnings,
    blockers,
  };
}

export default { validatePrescriptionSafety, checkAntithromboticInteractions };
