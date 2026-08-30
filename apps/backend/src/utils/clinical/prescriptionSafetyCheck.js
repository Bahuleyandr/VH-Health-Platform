import { createHash } from 'node:crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  getUnifiedActiveAllergiesDetailed,
  rankSeverity,
  SEVERE_BLOCK_RANK,
} from '../../services/clinical/allergySourceService.js';
import { evaluateDrugKb } from '../../services/clinical/drugKnowledgeBaseService.js';
import { resolveDrugKeys } from '../../services/clinical/drugKbLinkService.js';
import { isCompositionSearchEnabled } from '../../services/pharmacy/compositionFeatureService.js';
import {
  enrichMedicationsWithComposition,
  resolveCompositionIdentitiesByCatalogIds,
} from '../../services/pharmacy/compositionIdentityService.js';

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
 * Required patient context lookup for paediatric weight-based dosing.
 * Reads age (DOB) + most-recent recorded weight. Returns null if either
 * piece is missing — the dose check then silently skips for this patient
 * rather than 500'ing or false-flagging.
 */
async function loadPaediatricContext(patientId, db = prisma) {
  if (!patientId) return null;
  const rows = await db.$queryRawUnsafe(
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
  const weightRows = await db.$queryRawUnsafe(
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

async function loadPregnancyContext(patientId, db = prisma) {
  if (!patientId) return { activePregnancy: false, possiblePregnancy: false };
  const rows = await db.$queryRawUnsafe(
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
}

async function loadRenalContext(patientId, db = prisma) {
  if (!patientId) return { evidenceFound: false };
  const rows = await db.$queryRawUnsafe(
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

const ACTIVE_THERAPY_SOURCE_PRIORITY = new Map([
  ['pharmacy_order', 10],
  ['clinical_order', 20],
  ['e_prescription', 30],
  ['medication_reconciliation', 40],
  ['legacy_prescription', 45],
  ['chronic_medication', 50],
  ['mar_administration', 60],
  ['counter_sale', 70],
  ['specialty_therapy', 80],
  ['medication_reminder', 90],
]);

function activeTherapyPositiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function activeTherapyName(row) {
  return String(row?.medication_name || '').trim();
}

function activeTherapyDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function activeTherapyDurationDays(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload.days ?? payload.duration_days ?? payload.duration ?? payload.course_days;
  const direct = Number(raw);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const timingText = [raw, payload.instructions, payload.sig]
    .filter((value) => value != null)
    .join(' ');
  const match = timingText.match(/\b(\d{1,4})\s*(?:day|days|d)\b/i);
  return match ? Number(match[1]) : null;
}

function addActiveTherapyDays(value, days) {
  const parsed = activeTherapyDate(value);
  if (!parsed || !Number.isInteger(days) || days <= 0) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed;
}

function activeTherapyPayloadEnd(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const direct = payload.effective_end ?? payload.end_date ?? payload.endDate ?? payload.course_end;
  const directDate = activeTherapyDate(direct);
  if (directDate) return directDate;
  for (const instruction of payload.dosage_instruction || []) {
    const boundsEnd = instruction?.timing?.repeat?.boundsPeriod?.end;
    const parsed = activeTherapyDate(boundsEnd);
    if (parsed) return parsed;
  }
  return null;
}

function activeTherapyBlocker(type, row, message, extra = {}) {
  return {
    type,
    severity: 'HIGH',
    source: row?.source || null,
    source_id: row?.source_id == null ? null : String(row.source_id),
    medication: activeTherapyName(row) || null,
    message,
    ...extra,
  };
}

/**
 * Canonical patient-global active-therapy snapshot for pharmacist safety.
 * Every query uses the caller's tenant transaction. Source rows are reduced
 * to stable lineage, catalog, composition, timing and KB-key authority before
 * the snapshot is hashed.
 */
export async function loadActiveTherapySnapshot(patientId, {
  tenantId = null,
  db = prisma,
  excludePrescriptionId = null,
  excludePharmacyOrderId = null,
} = {}) {
  const blockers = [];
  const numericPatientId = activeTherapyPositiveInt(patientId);
  if (!tenantId || !numericPatientId) {
    blockers.push({
      type: 'ACTIVE_THERAPY_CONTEXT_UNAVAILABLE',
      severity: 'HIGH',
      recovery_action: 'resolve_same_tenant_patient_authority',
      message: 'Active-therapy screening requires explicit tenant and patient authority.',
    });
    const sha256 = createHash('sha256').update(JSON.stringify({ evidence: [], blockers })).digest('hex');
    return { medications: [], evidence: [], blockers, sha256 };
  }

  const patientRows = await db.$queryRawUnsafe(
    `SELECT id, uid, NOW() AS snapshot_at
       FROM users
      WHERE tenant_id=$1::uuid AND id=$2::int
        AND role='PATIENT' AND is_active=TRUE AND status='active'
        AND is_deleted=FALSE AND merged_into_uid IS NULL
      LIMIT 2
      FOR KEY SHARE`,
    tenantId,
    numericPatientId,
  );
  if (patientRows.length !== 1) {
    blockers.push({
      type: 'ACTIVE_THERAPY_CONTEXT_UNAVAILABLE',
      severity: 'HIGH',
      recovery_action: 'resolve_same_tenant_patient_authority',
      message: 'The active same-tenant patient identity could not be resolved uniquely.',
    });
    const sha256 = createHash('sha256').update(JSON.stringify({ evidence: [], blockers })).digest('hex');
    return { medications: [], evidence: [], blockers, sha256 };
  }
  const patientUid = String(patientRows[0].uid);
  const snapshotAt = activeTherapyDate(patientRows[0].snapshot_at);

  // Counter-sale lines carry an inventory item rather than a durable catalog
  // snapshot. Pin those same-tenant inventory mappings before projecting the
  // sale so catalog identity cannot change between source and catalog reads.
  await db.$queryRawUnsafe(
    `SELECT inventory.id
       FROM pharmacy_counter_sales sale
       JOIN pharmacy_counter_sale_lines line
         ON line.tenant_id=sale.tenant_id AND line.counter_sale_id=sale.id
       JOIN pharmacy_inventory_items inventory
         ON inventory.tenant_id=line.tenant_id AND inventory.id=line.inventory_item_id
      WHERE sale.tenant_id=$1::uuid AND sale.patient_uid=$2::uuid
        AND sale.status='COMPLETED' AND sale.voided_at IS NULL
      ORDER BY inventory.id
      FOR KEY SHARE OF inventory`,
    tenantId,
    patientUid,
  );

  const rawRows = await db.$queryRawUnsafe(
    `WITH latest_reconciliation AS (
       SELECT id
         FROM medication_reconciliations
        WHERE tenant_id=$1::uuid AND patient_uid=$3::uuid
          AND (patient_id IS NULL OR patient_id=$2::int)
          AND status='completed'
        ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
     )
     SELECT * FROM (
       SELECT 'e_prescription'::text AS source, ep.id::text AS source_id,
              COALESCE(ep.revision, 1)::text AS source_revision,
              CASE WHEN ep.pharmacy_order_id IS NOT NULL
                THEN 'pharmacy_order:' || ep.pharmacy_order_id::text
                ELSE 'e_prescription:' || ep.id::text END AS lineage_id,
              COALESCE((med.ordinality - 1)::text, '0') AS line_index,
              COALESCE(NULLIF(TRIM(med.value->>'name'), ''),
                       NULLIF(TRIM(med.value->>'medication_name'), ''),
                       NULLIF(TRIM(med.value->>'medicine_name'), ''),
                       NULLIF(TRIM(med.value->>'generic_name'), ''),
                       CASE WHEN med.ordinality IS NULL
                         THEN NULLIF(TRIM(ep.medication_name), '')
                       END) AS medication_name,
              COALESCE(NULLIF(med.value->>'catalog_id', ''),
                       NULLIF(med.value->>'original_catalog_id', '')) AS catalog_id,
              LOWER(COALESCE(ep.status, 'active')) AS source_status,
              ep.lifecycle_status,
              COALESCE(ep.signed_at, ep.created_at)::timestamptz AS effective_start,
              NULL::timestamptz AS effective_end,
              COALESCE(med.value, '{}'::jsonb) || jsonb_build_object(
                '_patient_uid_resolved', ep.patient_uid=$3::uuid,
                '_source_start_authoritative', ep.signed_at IS NOT NULL
                  OR NULLIF(med.value->>'effective_start', '') IS NOT NULL
                  OR NULLIF(med.value->>'start_date', '') IS NOT NULL
                  OR NULLIF(med.value->>'authored_on', '') IS NOT NULL
              ) AS line_payload
         FROM e_prescriptions ep
         LEFT JOIN LATERAL jsonb_array_elements(COALESCE(ep.medications, '[]'::jsonb))
           WITH ORDINALITY AS med(value, ordinality) ON TRUE
        WHERE ep.tenant_id=$1::uuid AND ep.patient_id=$2::int
          AND ep.id IS DISTINCT FROM $4::int
          AND LOWER(COALESCE(ep.status, 'active')) IN
              ('active', 'pharmacy_linked', 'fulfilled', 'on-hold', 'on_hold')
          AND (LOWER(COALESCE(ep.lifecycle_status, 'draft')) IN ('signed', 'imported_history')
               OR ep.signed_at IS NOT NULL)
       UNION ALL
       SELECT 'pharmacy_order', po.id::text, po.inventory_authority_version::text,
              'pharmacy_order:' || po.id::text,
              COALESCE(NULLIF(line.value->>'prescription_line_index', ''),
                       NULLIF(line.value->>'order_line_index', ''),
                       (line.ordinality - 1)::text),
              COALESCE(NULLIF(TRIM(line.value->>'name'), ''),
                       NULLIF(TRIM(line.value->>'medication_name'), ''),
                       NULLIF(TRIM(line.value->>'medicine_name'), ''),
                       NULLIF(TRIM(line.value->>'item_name'), '')),
              COALESCE(NULLIF(line.value->>'catalog_id', ''),
                       NULLIF(line.value->>'original_catalog_id', '')),
              CASE WHEN po.status IN ('DISPENSED', 'DELIVERED')
                THEN 'dispensed' ELSE 'active' END, 'governed_order',
              COALESCE(po.dispensed_at, po.ordered_at)::timestamptz, NULL::timestamptz,
              COALESCE(line.value, '{}'::jsonb) || jsonb_build_object(
                '_source_start_authoritative',
                po.status NOT IN ('DISPENSED', 'DELIVERED') OR po.dispensed_at IS NOT NULL
              )
         FROM pharmacy_orders po
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN po.status IN ('DISPENSED', 'DELIVERED')
             THEN COALESCE(po.dispensed_medications, po.items_list, '[]'::jsonb)
             ELSE COALESCE(po.items_list, '[]'::jsonb) END
         ) WITH ORDINALITY AS line(value, ordinality)
        WHERE po.tenant_id=$1::uuid AND po.patient_id=$2::int
          AND po.id IS DISTINCT FROM $5::int
          AND po.status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED',
                            'PARTIALLY_DISPENSED', 'ON_HOLD', 'DISPENSED', 'DELIVERED')
       UNION ALL
       SELECT 'clinical_order', clinical.id::text,
              EXTRACT(EPOCH FROM clinical.updated_at)::bigint::text,
              'clinical_order:' || clinical.id::text,
              COALESCE(NULLIF(clinical.details->>'line_index', ''),
                       LOWER(COALESCE(clinical.details->>'medication_name', clinical.details->>'name', ''))),
              COALESCE(NULLIF(TRIM(clinical.details->>'medication_name'), ''),
                       NULLIF(TRIM(clinical.details->>'name'), '')),
              NULLIF(clinical.details->>'catalog_id', ''), clinical.status, 'clinical_order',
              COALESCE(clinical.start_date, clinical.created_at), clinical.end_date,
              clinical.details || jsonb_build_object(
                'route', COALESCE(clinical.details->>'route', clinical.route)
              )
         FROM clinical_orders clinical
        WHERE clinical.tenant_id=$1::uuid AND clinical.patient_uid=$3::uuid
          AND clinical.order_type='medication'
          AND COALESCE(clinical.start_date, clinical.created_at) <= NOW()
          AND (clinical.end_date IS NULL OR clinical.end_date >= NOW())
          AND COALESCE(clinical.status, 'ordered')
                !~* '(cancelled|canceled|discontinued|stopped|suspended|completed)'
       UNION ALL
       SELECT 'mar_administration', administration.id::text,
              EXTRACT(EPOCH FROM administration.updated_at)::bigint::text,
              CASE WHEN administration.clinical_order_id IS NOT NULL
                THEN 'clinical_order:' || administration.clinical_order_id::text
                ELSE 'mar_administration:' || administration.id::text END,
              LOWER(administration.medication_name), administration.medication_name,
              NULLIF(clinical.details->>'catalog_id', ''),
              CASE WHEN LOWER(COALESCE(administration.status, 'scheduled')) IN ('scheduled', 'due')
                THEN 'scheduled' ELSE LOWER(administration.status) END, 'mar',
              COALESCE(administration.administered_at, administration.scheduled_time, administration.created_at),
              CASE WHEN LOWER(COALESCE(administration.status, 'scheduled'))='administered'
                THEN COALESCE(administration.administered_at, administration.scheduled_time) + INTERVAL '7 days'
                ELSE clinical.end_date END,
              jsonb_build_object('dose', COALESCE(administration.dose, administration.dosage),
                                 'route', administration.route)
         FROM medication_administrations administration
         LEFT JOIN clinical_orders clinical
           ON clinical.tenant_id=administration.tenant_id
          AND clinical.id=administration.clinical_order_id
          AND clinical.patient_uid=administration.patient_uid
          AND clinical.order_type='medication'
        WHERE administration.tenant_id=$1::uuid AND administration.patient_uid=$3::uuid
          AND LOWER(COALESCE(administration.status, 'scheduled')) IN
              ('scheduled', 'due', 'held', 'administered')
          AND (
            (LOWER(COALESCE(administration.status, 'scheduled')) IN ('scheduled', 'due', 'held')
             AND administration.scheduled_time BETWEEN NOW() - INTERVAL '24 hours'
                                                   AND NOW() + INTERVAL '7 days')
            OR
            (LOWER(COALESCE(administration.status, 'scheduled')) = 'administered'
             AND administration.administered_at >= NOW() - INTERVAL '7 days')
          )
       UNION ALL
       SELECT 'chronic_medication', patient.id::text,
              EXTRACT(EPOCH FROM COALESCE(patient.chronic_medications_updated_at, patient.registered_at))::bigint::text,
              'chronic:' || patient.id::text || ':' || (med.ordinality - 1)::text,
              (med.ordinality - 1)::text,
              COALESCE(NULLIF(TRIM(med.value->>'name'), ''), NULLIF(TRIM(med.value->>'medication_name'), '')),
              NULLIF(med.value->>'catalog_id', ''), 'active', 'patient_profile',
              patient.chronic_medications_updated_at, NULL::timestamptz, med.value
         FROM users patient
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(patient.chronic_medications, '[]'::jsonb))
           WITH ORDINALITY AS med(value, ordinality)
        WHERE patient.tenant_id=$1::uuid AND patient.id=$2::int AND patient.uid=$3::uuid
       UNION ALL
       SELECT 'medication_reconciliation', item.id::text,
              EXTRACT(EPOCH FROM item.updated_at)::bigint::text,
              COALESCE(NULLIF(item.source_ref, ''), 'medrec:' || item.id::text),
              item.id::text, item.medication_name,
              COALESCE(NULLIF(item.metadata->>'catalog_id', ''), NULLIF(item.metadata->>'catalogId', '')),
              item.decision, reconciliation.rec_type,
              reconciliation.completed_at, NULL::timestamptz,
              item.metadata || jsonb_build_object(
                'dose', CASE WHEN item.decision='change' THEN COALESCE(item.changed_dose, item.dose) ELSE item.dose END,
                'frequency', CASE WHEN item.decision='change' THEN COALESCE(item.changed_frequency, item.frequency) ELSE item.frequency END,
                'route', CASE WHEN item.decision='change' THEN COALESCE(item.changed_route, item.route) ELSE item.route END)
         FROM latest_reconciliation latest
         JOIN medication_reconciliations reconciliation ON reconciliation.id=latest.id
         JOIN medication_reconciliation_items item
           ON item.reconciliation_id=reconciliation.id AND item.tenant_id=reconciliation.tenant_id
       WHERE item.decision IN ('continue', 'change', 'new')
       UNION ALL
       SELECT 'legacy_prescription', prescription.id::text,
              EXTRACT(EPOCH FROM prescription.issued_at)::bigint::text,
              'legacy_prescription:' || prescription.id::text,
              prescription.id::text, prescription.medication_name,
              NULL::text, LOWER(COALESCE(prescription.status, 'active')), 'legacy_prescription',
              prescription.issued_at,
              CASE WHEN prescription.duration_days IS NOT NULL
                THEN prescription.issued_at + make_interval(days => prescription.duration_days)
                ELSE NULL END,
              jsonb_build_object('dose', prescription.dosage,
                                 'frequency', prescription.frequency,
                                 'duration_days', prescription.duration_days)
         FROM prescriptions prescription
        WHERE prescription.tenant_id=$1::uuid AND prescription.patient_uid=$3::uuid
          AND LOWER(COALESCE(prescription.status, 'active')) IN ('active', 'ongoing')
       UNION ALL
       SELECT 'counter_sale', line.id::text,
              EXTRACT(EPOCH FROM sale.updated_at)::bigint::text,
              'counter_sale:' || sale.id::text || ':' || line.id::text,
              line.id::text, line.item_name, inventory.catalog_id::text,
              sale.status, 'registered_counter_sale', sale.updated_at, NULL::timestamptz,
              jsonb_build_object('quantity', line.quantity, 'inventory_item_id', line.inventory_item_id)
         FROM pharmacy_counter_sales sale
         JOIN pharmacy_counter_sale_lines line
           ON line.tenant_id=sale.tenant_id AND line.counter_sale_id=sale.id
         JOIN pharmacy_inventory_items inventory
           ON inventory.tenant_id=line.tenant_id AND inventory.id=line.inventory_item_id
        WHERE sale.tenant_id=$1::uuid AND sale.patient_uid=$3::uuid
          AND sale.status='COMPLETED' AND sale.voided_at IS NULL
     ) therapy
     WHERE medication_name IS NOT NULL AND BTRIM(medication_name) <> ''`,
    tenantId,
    numericPatientId,
    patientUid,
    excludePrescriptionId == null ? null : Number(excludePrescriptionId),
    excludePharmacyOrderId == null ? null : Number(excludePharmacyOrderId),
  );

  const specialtyRows = await db.$queryRawUnsafe(
    `SELECT * FROM (
       SELECT 'specialty_therapy'::text AS source,
              'chemo:' || administration.id::text AS source_id,
              EXTRACT(EPOCH FROM administration.updated_at)::bigint::text AS source_revision,
              'chemo:' || administration.id::text AS lineage_id,
              administration.id::text AS line_index,
              administration.drug_name AS medication_name,
              NULL::text AS catalog_id, administration.status AS source_status,
              'oncology'::text AS lifecycle_status,
              COALESCE(administration.administered_at, cycle.scheduled_date::timestamptz) AS effective_start,
              CASE WHEN administration.administered_at IS NOT NULL
                THEN administration.administered_at + INTERVAL '7 days' ELSE NULL END AS effective_end,
              jsonb_build_object('dose', administration.final_dose, 'route', administration.route) AS line_payload
         FROM chemo_administrations administration
         JOIN chemo_cycles cycle ON cycle.tenant_id=administration.tenant_id AND cycle.id=administration.cycle_id
         JOIN chemo_treatment_plans plan ON plan.tenant_id=cycle.tenant_id AND plan.id=cycle.plan_id
        WHERE administration.tenant_id=$1::uuid AND plan.patient_uid=$2::uuid
          AND administration.status IN ('pending', 'first_verified', 'double_verified', 'administered')
          AND (administration.status <> 'administered'
               OR administration.administered_at >= NOW() - INTERVAL '7 days')
       UNION ALL
       SELECT 'specialty_therapy', 'dialysis:' || prescription.id::text,
              EXTRACT(EPOCH FROM prescription.updated_at)::bigint::text,
              'dialysis:' || prescription.id::text, 'anticoagulant',
              prescription.anticoag, NULL::text, prescription.status, 'dialysis',
              prescription.valid_from::timestamptz, prescription.superseded_at,
              jsonb_build_object('dose', prescription.anticoag_loading,
                                 'maintenance', prescription.anticoag_maintenance)
         FROM dialysis_prescriptions prescription
         JOIN dialysis_patients patient
           ON patient.tenant_id=prescription.tenant_id AND patient.id=prescription.dialysis_patient_id
        WHERE prescription.tenant_id=$1::uuid AND patient.patient_uid=$2::uuid
          AND prescription.status='active' AND prescription.valid_from <= CURRENT_DATE
          AND BTRIM(prescription.anticoag) <> ''
          AND LOWER(BTRIM(prescription.anticoag)) NOT IN
              ('none', 'no anticoagulation', 'saline', 'saline flush')
       UNION ALL
       SELECT 'specialty_therapy', 'maternity:' || supplement.id::text,
              EXTRACT(EPOCH FROM supplement.updated_at)::bigint::text,
              'maternity:' || supplement.id::text, supplement.id::text,
              supplement.supplement, NULL::text, 'active', 'maternity',
              supplement.start_date::timestamptz, supplement.end_date::timestamptz,
              jsonb_build_object('dose', supplement.dose, 'frequency', supplement.frequency,
                                 'route', supplement.route)
         FROM maternity_supplements supplement
         JOIN maternity_pregnancies pregnancy
           ON pregnancy.tenant_id=supplement.tenant_id AND pregnancy.id=supplement.pregnancy_id
        WHERE supplement.tenant_id=$1::uuid AND pregnancy.patient_uid=$2::uuid
          AND supplement.start_date <= CURRENT_DATE
          AND (supplement.end_date IS NULL OR supplement.end_date >= CURRENT_DATE)
       UNION ALL
       SELECT 'specialty_therapy', 'resuscitation:' || link.id::text,
              EXTRACT(EPOCH FROM link.updated_at)::bigint::text,
              'resuscitation:' || link.id::text, link.id::text,
              link.medication_name, NULL::text, link.reconciliation_status, 'emergency',
              link.created_at, link.created_at + INTERVAL '7 days',
              jsonb_build_object('dose', link.dose, 'route', link.route)
         FROM resuscitation_medication_links link
        WHERE link.tenant_id=$1::uuid AND link.patient_uid=$2::uuid
          AND link.mar_administration_id IS NULL
          AND link.created_at >= NOW() - INTERVAL '7 days'
       UNION ALL
       SELECT 'medication_reminder', reminder.id::text,
              EXTRACT(EPOCH FROM reminder.updated_at)::bigint::text,
              'medication_reminder:' || reminder.id::text, reminder.id::text,
              reminder.medication_name, NULL::text,
              CASE WHEN reminder.is_active THEN 'active' ELSE 'inactive' END,
              'patient_reported', reminder.start_date::timestamptz,
              reminder.end_date::timestamptz,
              jsonb_build_object('dose', reminder.dosage, 'frequency', reminder.frequency)
         FROM medication_reminders reminder
        WHERE reminder.tenant_id=$1::uuid AND reminder.patient_uid=$2::uuid
          AND reminder.is_active=TRUE AND reminder.start_date <= CURRENT_DATE
          AND (reminder.end_date IS NULL OR reminder.end_date >= CURRENT_DATE)
     ) specialty`,
    tenantId,
    patientUid,
  );
  rawRows.push(...specialtyRows);

  // Collapse only duplicate ingestion/linkage representations using their
  // durable lineage (for example an e-prescription that has become a pharmacy
  // order). Independent source lineages remain separately hash-visible.
  const sourcePriority = (row) => ACTIVE_THERAPY_SOURCE_PRIORITY.get(row?.source) ?? 999;
  const lineageRows = new Map();
  for (const row of rawRows) {
    const medicationName = activeTherapyName(row);
    if (!medicationName) continue;
    const lineIndex = String(row.line_index || medicationName.toLowerCase());
    const lineageId = String(row.lineage_id || `${row.source}:${row.source_id}`);
    const lineageKey = `${lineageId}:${lineIndex}`;
    const candidate = { ...row, lineage_sources: [String(row.source)] };
    const current = lineageRows.get(lineageKey);
    if (!current || sourcePriority(candidate) < sourcePriority(current)) {
      candidate.lineage_sources = [
        ...new Set([...(current?.lineage_sources || []), ...candidate.lineage_sources]),
      ].sort();
      lineageRows.set(lineageKey, candidate);
    } else if (!current.lineage_sources.includes(candidate.source)) {
      current.lineage_sources.push(candidate.source);
      current.lineage_sources.sort();
    }
  }

  // Preserve every independent lineage in the hash. Catalog/name deduplication
  // happens only in the returned interaction projection after the evidence is
  // built; otherwise a lower-priority source timing/revision change would not
  // invalidate verification.
  const candidateRows = [...lineageRows.values()];

  // Terminal dispensing/import/counter-sale rows are historical exposures, not
  // indefinitely active medication authority. If the source does not provide a
  // course duration, verification must stop for reconciliation instead of using
  // an arbitrary clinical window.
  for (const row of candidateRows) {
    const status = String(row.source_status || '').toLowerCase();
    const lifecycle = String(row.lifecycle_status || '').toLowerCase();
    if (row.source === 'e_prescription' && row.line_payload?._patient_uid_resolved !== true) {
      blockers.push({
        type: 'ACTIVE_THERAPY_PATIENT_AUTHORITY_UNRESOLVED',
        severity: 'HIGH',
        source: 'e_prescription',
        source_id: String(row.source_id),
        recovery_action: 'repair_prescription_patient_authority',
        message: 'An active prescription does not carry the canonical same-tenant patient UUID.',
      });
      continue;
    }
    const requiresFiniteTiming = (
      (row.source === 'pharmacy_order' && ['dispensed', 'delivered'].includes(status))
      || (row.source === 'e_prescription' && status === 'fulfilled')
      || (row.source === 'e_prescription' && lifecycle === 'imported_history')
      || (row.source === 'e_prescription'
        && String(row.line_payload?.source || '').toLowerCase() === 'discharge_summary')
      || row.source === 'counter_sale'
      || (row.source === 'mar_administration' && status === 'administered')
      || (row.source === 'specialty_therapy' && status === 'administered')
      || (row.source === 'specialty_therapy' && lifecycle === 'emergency')
    );
    if (!activeTherapyDate(row.effective_end)) {
      row.effective_end = activeTherapyPayloadEnd(row.line_payload);
    }
    if (requiresFiniteTiming && !activeTherapyDate(row.effective_end)) {
      const requiresStartMarker = row.source === 'e_prescription'
        || row.source === 'pharmacy_order';
      if (!requiresStartMarker || row.line_payload?._source_start_authoritative === true) {
        row.effective_end = addActiveTherapyDays(
          row.effective_start,
          activeTherapyDurationDays(row.line_payload),
        );
      }
      if (!row.effective_end) {
        blockers.push(activeTherapyBlocker(
          'ACTIVE_THERAPY_TIMING_UNRESOLVED',
          row,
          'A historical medication exposure has no authoritative course end; reconcile its timing before verification.',
          {
            lineage_id: String(row.lineage_id || `${row.source}:${row.source_id}`),
            recovery_action: 'complete_medication_reconciliation_timing',
          },
        ));
      }
    }
  }

  // Finite courses stop contributing once their authoritative end passes the
  // database transaction timestamp. Unresolved finite timing remains in scope
  // with its blocker, so wall-clock expiry can never silently manufacture an
  // end date.
  const rows = candidateRows.filter((row) => {
    const end = activeTherapyDate(row.effective_end);
    return !end || !snapshotAt || end.getTime() > snapshotAt.getTime();
  });
  const authorityRows = rows.filter((row) => (
    row.source !== 'e_prescription' || row.line_payload?._patient_uid_resolved === true
  ));
  const quarantinedEvidence = rows
    .filter((row) => row.source === 'e_prescription'
      && row.line_payload?._patient_uid_resolved !== true)
    .map((row) => ({
      source: 'e_prescription',
      source_id: String(row.source_id),
      source_revision: String(row.source_revision || ''),
      lineage_id: String(row.lineage_id || `e_prescription:${row.source_id}`),
      line_index: String(row.line_index || ''),
      lineage_sources: [...new Set(row.lineage_sources || ['e_prescription'])].sort(),
      patient_authority_resolved: false,
    }));

  const catalogIds = [...new Set(authorityRows
    .map((row) => activeTherapyPositiveInt(row.catalog_id))
    .filter((value) => value !== null))].sort((a, b) => a - b);
  const catalogRows = catalogIds.length > 0
    ? await db.$queryRawUnsafe(
      `SELECT id, name, generic_name, composition_id, strength, strength_key,
              form, form_key, release_key, route, updated_at
         FROM pharmacy_catalog
        WHERE tenant_id=$1::uuid AND is_active=TRUE
          AND id=ANY($2::int[])
        ORDER BY id
        FOR KEY SHARE`,
      tenantId,
      catalogIds,
    )
    : [];
  const catalogById = new Map(catalogRows.map((row) => [Number(row.id), row]));
  const compositionIds = [...new Set(catalogRows
    .map((row) => activeTherapyPositiveInt(row.composition_id))
    .filter((value) => value !== null))].sort((a, b) => a - b);
  const compositionRows = compositionIds.length > 0
    ? await db.$queryRawUnsafe(
      `SELECT id, composition_key, active_ingredients, updated_at
         FROM drug_compositions
        WHERE id=ANY($1::int[])
        ORDER BY id
        FOR KEY SHARE`,
      compositionIds,
    )
    : [];
  const compositionById = new Map(compositionRows.map((row) => [Number(row.id), row]));

  const medicationsForKb = [];
  for (const row of authorityRows) {
    const catalogId = activeTherapyPositiveInt(row.catalog_id);
    const catalog = catalogId == null ? null : catalogById.get(catalogId);
    const compositionId = activeTherapyPositiveInt(catalog?.composition_id);
    const composition = compositionId == null ? null : compositionById.get(compositionId);
    if (!catalog || !composition || !Array.isArray(composition.active_ingredients)
      || composition.active_ingredients.length === 0) {
      blockers.push(activeTherapyBlocker(
        'ACTIVE_THERAPY_IDENTITY_UNRESOLVED',
        row,
        'The active therapy is not pinned to an active same-tenant catalog item and governed composition.',
        {
          catalog_id: catalogId,
          recovery_action: 'map_therapy_to_tenant_catalog_composition',
        },
      ));
    }
    medicationsForKb.push({
      name: String(catalog?.name || activeTherapyName(row)),
      medication_name: String(catalog?.name || activeTherapyName(row)),
      catalog_id: catalogId,
      composition_id: compositionId,
      composition_key: composition?.composition_key || null,
      active_ingredients: [...(composition?.active_ingredients || [])].map(String).sort(),
      dose: row.line_payload?.dose ?? row.line_payload?.dosage ?? catalog?.strength ?? null,
      route: row.line_payload?.route ?? catalog?.route ?? null,
      catalog_strength: catalog?.strength ?? null,
      catalog_strength_key: catalog?.strength_key ?? null,
      catalog_form: catalog?.form ?? null,
      catalog_form_key: catalog?.form_key ?? null,
      catalog_release_key: catalog?.release_key ?? null,
      source: row.source,
    });
  }

  let kbResolutions = medicationsForKb.map(() => null);
  if (medicationsForKb.length > 0 && medicationsForKb.every((med) => med.catalog_id != null)) {
    try {
      const resolved = await resolveDrugKeys({
        tenantId,
        medications: medicationsForKb,
        db,
        strict: true,
      });
      kbResolutions = resolved.resolutions || kbResolutions;
    } catch (err) {
      blockers.push({
        type: 'DRUG_KB_IDENTITY_UNRESOLVED',
        severity: 'HIGH',
        catalog_ids: [...new Set(err?.catalogIds || medicationsForKb.map((med) => med.catalog_id))]
          .filter((value) => value != null)
          .sort((a, b) => Number(a) - Number(b)),
        recovery_action: 'curate_or_link_catalog_drug_kb_identity',
        message: 'One or more active therapies have no deterministic identity in the pinned drug knowledge base.',
      });
    }
  }

  const evidence = authorityRows.map((row, index) => {
    const medication = medicationsForKb[index];
    const resolution = kbResolutions[index];
    return {
      source: String(row.source),
      source_id: String(row.source_id),
      source_revision: String(row.source_revision || ''),
      lineage_id: String(row.lineage_id || `${row.source}:${row.source_id}`),
      line_index: String(row.line_index || ''),
      lineage_sources: [...new Set(row.lineage_sources || [row.source])].sort(),
      medication_name: medication.medication_name,
      catalog_id: medication.catalog_id,
      composition_id: medication.composition_id,
      composition_key: medication.composition_key,
      active_ingredients: medication.active_ingredients,
      dose: medication.dose,
      route: medication.route,
      catalog_strength: medication.catalog_strength,
      catalog_strength_key: medication.catalog_strength_key,
      catalog_form: medication.catalog_form,
      catalog_form_key: medication.catalog_form_key,
      catalog_release_key: medication.catalog_release_key,
      kb_drug_keys: [...(resolution?.drug_keys || [])].map(String).sort(),
      kb_resolution_tier: resolution?.tier || null,
      source_status: row.source_status == null ? null : String(row.source_status),
      lifecycle_status: row.lifecycle_status == null ? null : String(row.lifecycle_status),
      patient_authority_resolved: row.source !== 'e_prescription'
        || row.line_payload?._patient_uid_resolved === true,
      effective_start: activeTherapyDate(row.effective_start)?.toISOString() || null,
      effective_end: activeTherapyDate(row.effective_end)?.toISOString() || null,
    };
  }).concat(quarantinedEvidence).sort((a, b) => (
    `${a.source}:${a.source_id}:${a.lineage_id}:${a.line_index}`
      .localeCompare(`${b.source}:${b.source_id}:${b.lineage_id}:${b.line_index}`)
  ));
  const stableBlockers = blockers.map((blocker) => ({ ...blocker })).sort((a, b) => (
    `${a.type}:${a.source || ''}:${a.source_id || ''}:${a.medication || ''}`
      .localeCompare(`${b.type}:${b.source || ''}:${b.source_id || ''}:${b.medication || ''}`)
  ));
  const sha256 = createHash('sha256')
    .update(JSON.stringify({ evidence, blockers: stableBlockers }))
    .digest('hex');

  const interactionMedicationByIdentity = new Map();
  for (const medication of medicationsForKb) {
    const identity = medication.catalog_id == null
      ? `name:${String(medication.medication_name || '').toLowerCase()}`
      : `catalog:${medication.catalog_id}`;
    if (!interactionMedicationByIdentity.has(identity)) {
      interactionMedicationByIdentity.set(identity, medication);
    }
  }

  return {
    medications: [...interactionMedicationByIdentity.values()],
    evidence,
    blockers: stableBlockers,
    sha256,
    patientUid,
  };
}

/**
 * Validate a prescription against patient allergies and active medications.
 * Call before saving any new prescription.
 * @param {number} patientId
 * @param {Array} medications - [{ medication_id, name, ... }]
 * @param {object} [options]
 * @param {string|null} [options.tenantId] tenant uuid; when present AND the
 *   per-tenant composition-search flag is enabled, an additional (guarded)
 *   composition allergy + same-composition duplicate screen runs. Omitting it
 *   (legacy 2-arg callers) degrades cleanly to no composition checks.
 * @returns {{ safe: boolean, warnings: Array, blockers: Array }}
 */
export async function validatePrescriptionSafety(patientId, medications, options = {}) {
  const warnings = [];
  const blockers = [];
  const tenantId = options.tenantId ?? null;
  const db = options.db || prisma;
  let activeTherapyEvidence = [];
  let activeTherapySha256 = null;

  try {
    // 1. Check patient allergies — ALL stores (roadmap A10). The old query
    // read patient_allergies by patient_id only, so it missed: uid-keyed
    // patient_allergies rows, the legacy `allergies` import table (written
    // by patientDataImport, previously read only by CCDA/FHIR exporters),
    // the users.allergies profile text, and admission-intake allergies.
    // The detailed contract is mandatory here. Any unavailable required
    // source is itself a blocker; an empty array is safe only when every
    // source was actually queried for a resolved patient.
    const allergyContext = await getUnifiedActiveAllergiesDetailed(db, { patientId });
    const allergies = allergyContext.allergies;
    if (!allergyContext.patientResolved || allergyContext.sourcesFailed.length > 0) {
      blockers.push({
        type: 'SAFETY_CONTEXT_UNAVAILABLE',
        severity: 'HIGH',
        sources_failed: allergyContext.sourcesFailed,
        patient_resolved: allergyContext.patientResolved,
        manual_allergy_review_required: true,
        message: 'Required patient allergy sources were unavailable; complete and document a manual allergy review before any override.',
      });
    }

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
    const noteRows = await db.$queryRawUnsafe(
      `SELECT source, body FROM (
         SELECT 'appointment' AS source,
                COALESCE(notes, '') || ' ' || COALESCE(reason, '') AS body,
                created_at
           FROM appointments
          WHERE patient_id = $1::int
            AND ($2::uuid IS NULL OR tenant_id=$2::uuid)
            AND created_at >= NOW() - INTERVAL '365 days'
          ORDER BY created_at DESC
          LIMIT 50
       ) a
       UNION ALL
       SELECT source, body FROM (
         SELECT 'clinical_note' AS source,
                COALESCE(cn.notes, '') || ' ' || COALESCE(cn.content::text, '') AS body
           FROM clinical_notes cn
           JOIN users u ON u.uid = cn.patient_uid
          WHERE u.id = $1::int
            AND ($2::uuid IS NULL OR cn.tenant_id=$2::uuid)
            AND cn.created_at >= NOW() - INTERVAL '365 days'
            AND COALESCE(cn.status, 'current') NOT IN ('superseded', 'deleted')
          ORDER BY cn.created_at DESC
          LIMIT 50
       ) c`,
      patientId,
      tenantId,
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

    // 2. Resolve one patient-global active-therapy authority snapshot in this
    // transaction. The snapshot itself owns source timing, lineage collapse,
    // tenant catalog/composition locks, deterministic KB identity and hashing.
    const activeTherapy = await loadActiveTherapySnapshot(patientId, {
      tenantId,
      db,
      excludePrescriptionId: options.excludePrescriptionId,
      excludePharmacyOrderId: options.excludePharmacyOrderId,
    });
    activeTherapyEvidence = activeTherapy.evidence;
    activeTherapySha256 = activeTherapy.sha256;
    blockers.push(...activeTherapy.blockers);
    const activeMedsResult = activeTherapy.evidence;
    const interactionMedications = [...medications, ...activeTherapy.medications];

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

    // 2b. Composition-based allergy + same-composition duplicate screen
    //     (Phase 2, GATED + GUARDED). Server-authoritative: identity is
    //     derived ONLY from each med's tenant-scoped catalog_id — a
    //     client-sent composition_id is never trusted (enrich strips it).
    //
    //     GATING: does nothing unless a truthy tenantId is supplied AND the
    //     per-tenant composition-search flag is enabled. Legacy 2-arg callers
    //     (no options.tenantId) and disabled tenants skip this entirely.
    //
    //     When enabled, composition screening is required evidence. Any lookup
    //     fault reaches the outer fail-closed blocker rather than presenting
    //     the deterministic floor as a complete safety verdict.
    if (tenantId && await isCompositionSearchEnabled(tenantId, { db, bypassCache: true })) {
        // -- Composition allergy --
        // enrichMedicationsWithComposition strips any client identity and
        // overlays the server-derived one from catalog_id. Never throws.
        const enriched = await enrichMedicationsWithComposition(tenantId, medications, { db });
        for (const med of enriched) {
          if (med.composition_confidence !== 'high') continue;
          if (!Array.isArray(med.active_ingredients)) continue;
          const brand = med.name || med.medication_name || '';
          for (const rawMolecule of med.active_ingredients) {
            // active_ingredients are stored canonically with spaces normalized to
            // underscores (compositionParser: \s+ → _), e.g. 'clavulanic_acid'.
            // A patient allergen is spaced free-text ('clavulanic acid'), so
            // substring matching on the raw underscored token would MISS a real
            // multi-word molecule allergy. De-underscore before matching (and use
            // the readable form in the surfaced finding). Single-word molecules
            // are unaffected.
            const molecule = String(rawMolecule).replace(/_/g, ' ').trim();
            for (const allergy of allergies) {
              if (!medicationConflictsWithAllergen(molecule, allergy.allergen)) continue;
              // Dedup: skip if an existing ALLERGY_CONFLICT-family issue already
              // covers the same medication + allergy pair (e.g. the name-based
              // structured/unstructured loop already flagged this brand for this
              // allergen). Filter on TYPE — mirroring the KB dedup guard below —
              // so a future non-allergy check that happens to carry a matching
              // medication+allergen can never silently suppress a real
              // composition allergy.
              const alreadyFlagged = blockers.concat(warnings).some(
                (b) =>
                  (b.type === 'ALLERGY_CONFLICT' || b.type === 'ALLERGY_CONFLICT_UNSTRUCTURED') &&
                  String(b.medication || '').toLowerCase() === String(brand).toLowerCase() &&
                  String(b.allergy || '').toLowerCase() === String(allergy.allergen || '').toLowerCase(),
              );
              if (alreadyFlagged) continue;
              const issue = {
                type: 'COMPOSITION_ALLERGY_CONFLICT',
                medication: brand,
                molecule,
                allergy: allergy.allergen,
                severity: allergy.severity || 'UNKNOWN',
                message: `"${brand}" contains ${molecule}; patient has a "${allergy.allergen}" allergy`,
              };
              // Same severity gate as the name-based loop: SEVERE/CONTRAINDICATED
              // and above are hard blockers; below that, a warning.
              if (rankSeverity(allergy.severity) >= SEVERE_BLOCK_RANK) {
                blockers.push(issue);
              } else {
                warnings.push(issue);
              }
            }
          }
        }

        // -- Same-composition duplicate --
        // Flag when a submitted high-confidence composition matches (a) another
        // submitted med, (b) an active existing e-Rx med, or (c) an active
        // inpatient medication order — all HIGH-CONFIDENCE on both sides.
        const submitted = enriched
          .filter((m) => m.composition_confidence === 'high' && m.composition_id != null)
          .map((m) => ({
            brand: m.name || m.medication_name || '',
            compositionId: Number(m.composition_id),
          }));

        if (submitted.length > 0) {
          // Resolve patient_uid once — clinical_orders are keyed by UUID, not
          // the integer id.
          const uidRows = await db.$queryRawUnsafe(
            `SELECT uid FROM users WHERE id = $1 LIMIT 1`,
            patientId,
          );
          const patientUid = uidRows[0]?.uid || null;

          // Active e-Rx catalog ids (same status filter as the name-based
          // duplicate query above). One row per medication line.
          const eRxRows = await db.$queryRawUnsafe(
            `SELECT med.value->>'catalog_id' AS catalog_id, med.value->>'name' AS name
               FROM e_prescriptions ep
               LEFT JOIN LATERAL jsonb_array_elements(COALESCE(ep.medications, '[]'::jsonb)) AS med(value) ON TRUE
              WHERE ep.patient_id = $1
                AND LOWER(COALESCE(ep.status, 'active')) IN ('active', 'pharmacy_linked')
                AND (ep.follow_up_date IS NULL OR ep.follow_up_date >= CURRENT_DATE)`,
            patientId,
          );

          // Active IPD (clinical_orders) medication catalog ids.
          let ipdRows = [];
          if (patientUid) {
            ipdRows = await db.$queryRawUnsafe(
              `SELECT co.details->>'catalog_id' AS catalog_id, co.details->>'medication_name' AS name
                 FROM clinical_orders co
                WHERE co.patient_uid = $1::uuid
                  AND co.order_type = 'medication'
                  AND COALESCE(co.status, 'ordered') !~* '(cancelled|canceled|discontinued|stopped|on[\\s_-]?hold|suspended|completed)'`,
              patientUid,
            );
          }

          // Resolve the active-source catalog ids (e-Rx + IPD) in ONE call →
          // high-confidence composition ids only.
          const activeCatalogIds = [];
          const eRxByCatalog = new Map();
          const ipdByCatalog = new Map();
          for (const r of eRxRows) {
            const cid = Number(r.catalog_id);
            if (Number.isInteger(cid) && cid > 0) {
              activeCatalogIds.push(cid);
              if (!eRxByCatalog.has(cid)) eRxByCatalog.set(cid, r.name || '');
            }
          }
          for (const r of ipdRows) {
            const cid = Number(r.catalog_id);
            if (Number.isInteger(cid) && cid > 0) {
              activeCatalogIds.push(cid);
              if (!ipdByCatalog.has(cid)) ipdByCatalog.set(cid, r.name || '');
            }
          }

          const activeIdentities = await resolveCompositionIdentitiesByCatalogIds(
            tenantId,
            activeCatalogIds,
            { db },
          );

          // Build composition_id -> [{ brand, source }] for active meds
          // (high-confidence only, on the EXISTING side too).
          const activeByComposition = new Map();
          for (const [cid, brandName] of eRxByCatalog) {
            const identity = activeIdentities.get(cid);
            if (!identity || identity.composition_confidence !== 'high' || identity.composition_id == null) continue;
            const list = activeByComposition.get(Number(identity.composition_id)) || [];
            list.push({ brand: brandName || identity.name || '', source: 'active_prescription' });
            activeByComposition.set(Number(identity.composition_id), list);
          }
          for (const [cid, brandName] of ipdByCatalog) {
            const identity = activeIdentities.get(cid);
            if (!identity || identity.composition_confidence !== 'high' || identity.composition_id == null) continue;
            const list = activeByComposition.get(Number(identity.composition_id)) || [];
            list.push({ brand: brandName || identity.name || '', source: 'inpatient_order' });
            activeByComposition.set(Number(identity.composition_id), list);
          }

          // Emit one DUPLICATE_COMPOSITION warning per (brand, otherBrand, source)
          // pair, de-duped.
          const emittedDupKeys = new Set();
          const pushDup = (brand, otherBrand, source) => {
            const key = `${String(brand).toLowerCase()}|${String(otherBrand).toLowerCase()}|${source}`;
            if (emittedDupKeys.has(key)) return;
            emittedDupKeys.add(key);
            warnings.push({
              type: 'DUPLICATE_COMPOSITION',
              medication: brand,
              duplicate_of: otherBrand,
              source,
              message: `"${brand}" has the same composition as "${otherBrand}" already active for this patient (${source})`,
            });
          };

          for (let i = 0; i < submitted.length; i += 1) {
            const cur = submitted[i];
            // (a) another submitted med with the same composition.
            for (let j = 0; j < submitted.length; j += 1) {
              if (j === i) continue;
              const other = submitted[j];
              if (other.compositionId !== cur.compositionId) continue;
              // De-dup the unordered pair so only one warning is emitted for
              // A↔B (the first-seen ordering wins).
              const pairKey = `submitted|${[String(cur.brand).toLowerCase(), String(other.brand).toLowerCase()].sort().join('~')}`;
              if (emittedDupKeys.has(pairKey)) continue;
              emittedDupKeys.add(pairKey);
              pushDup(cur.brand, other.brand, 'submitted');
            }
            // (b)/(c) an active e-Rx or IPD med with the same composition.
            const activeMatches = activeByComposition.get(cur.compositionId) || [];
            for (const match of activeMatches) {
              pushDup(cur.brand, match.brand, match.source);
            }
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
    const paedCtx = await loadPaediatricContext(patientId, db);
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
    const antithrombotic = checkAntithromboticInteractions(interactionMedications);
    warnings.push(...antithrombotic.warnings);
    blockers.push(...antithrombotic.blockers);

    // 5. Pregnancy / lactation-adjacent medication safety. This is not a
    // complete teratogenicity database; it is a conservative first-trial
    // guard for the highest-signal drugs and ACEi/ARB/statin/tetracycline
    // classes. Active pregnancy + high-risk drug blocks until a clinician
    // overrides with reason; reproductive-age unknown status warns.
    const pregnancyContext = await loadPregnancyContext(patientId, db);
    const pregnancySafety = checkPregnancyMedicationSafety(medications, pregnancyContext);
    warnings.push(...pregnancySafety.warnings);
    blockers.push(...pregnancySafety.blockers);

    // 6. Renal dose / nephrotoxin review. When recent creatinine/eGFR is
    // present and severe, high-risk renal drugs block; otherwise they warn.
    // If no recent renal lab exists, renal-risk medicines warn so OPD can
    // order/check KFT instead of assuming safety.
    const renalContext = await loadRenalContext(patientId, db);
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
      const patientRows = await db.$queryRawUnsafe(
        `SELECT uid,
                CASE WHEN birthday IS NOT NULL THEN DATE_PART('year', AGE(NOW()::date, birthday))::int
                     ELSE NULL END AS age_years
           FROM users WHERE id = $1 LIMIT 1`,
        patientId,
      );
      const patientUid = patientRows[0]?.uid || null;
      let activeProblems = [];
      if (patientUid) {
        activeProblems = await db.$queryRawUnsafe(
            `SELECT icd10_code, title FROM patient_problems
              WHERE patient_uid = $1::uuid AND status = 'active'`,
            patientUid,
        );
      }
      const kbResult = await evaluateDrugKb({
        medications: interactionMedications,
        allergies,
        problems: activeProblems,
        tenantId,
        knowledgeRevision: options.knowledgeRevision ?? null,
        db,
        strictIdentity: options.requireActiveTherapyAuthority === true,
        patient: {
          ageYears: patientRows[0]?.age_years ?? paedCtx?.ageYears ?? null,
          weightKg: paedCtx?.weightKg ?? null,
          egfr: renalContext?.egfr ?? null,
        },
      });
      if (kbResult.kbAvailable !== true) {
        blockers.push({
          type: 'DRUG_KB_UNAVAILABLE',
          severity: 'HIGH',
          message: 'The authoritative medication knowledge base is unavailable; verification cannot complete safely.',
        });
      }
      if (options.requireActiveTherapyAuthority === true && kbResult.identityAvailable !== true) {
        blockers.push({
          type: 'DRUG_KB_IDENTITY_UNRESOLVED',
          severity: 'HIGH',
          message: 'The proposed and active therapies could not be pinned to deterministic drug knowledge identities.',
        });
      }
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
      logger.error('Drug KB evaluation failed (blocking prescription pending manual override):', kbErr.message);
      blockers.push({
        type: 'DRUG_KB_CHECK_ERROR',
        severity: 'HIGH',
        message: 'Drug knowledge-base screening failed — manual review and override are required before prescribing.',
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
    return {
      safe: false,
      warnings,
      blockers,
      active_therapy_evidence: activeTherapyEvidence,
      active_therapy_sha256: activeTherapySha256,
    };
  }

  return {
    safe: blockers.length === 0,
    warnings,
    blockers,
    active_therapy_evidence: activeTherapyEvidence,
    active_therapy_sha256: activeTherapySha256,
  };
}

export default { validatePrescriptionSafety, loadActiveTherapySnapshot, checkAntithromboticInteractions };
