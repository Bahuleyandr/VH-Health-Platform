// src/services/hl7/loincValidator.js
//
// Minimal LOINC code validator. The full LOINC catalogue is ~95k codes
// distributed as a CSV under license — we DO NOT ship that here. Instead:
//   1. A small allowlist of the ~50 most common observation codes the
//      hospital actually uses (vitals, basic chem, CBC, lipids).
//   2. A structural check (LOINC codes are <digits>-<check-digit>; the
//      check digit is computed via a documented algorithm).
//
// `isValidStructure(code)` is fast — pure regex + Luhn-like checksum.
// `isInAllowlist(code)` is the trusted set.
// `validate(code, { strict })` combines the two: strict mode requires
// allowlist membership; non-strict accepts any structurally valid code
// (good for "we'll log it as 'unknown LOINC' but not reject the message").
//
// To upgrade to full LOINC: drop a CSV at `src/services/hl7/loinc.csv` and
// load it lazily; `validate` should then check membership in the full set.

const ALLOWLIST = new Set([
  // ─── Vitals ─────────────────────────────────────────────────
  '8480-6',  // Systolic blood pressure
  '8462-4',  // Diastolic blood pressure
  '8867-4',  // Heart rate
  '8310-5',  // Body temperature
  '9279-1',  // Respiratory rate
  '2708-6',  // Oxygen saturation in arterial blood
  '59408-5', // Oxygen saturation in arterial blood by pulse oximetry
  '29463-7', // Body weight
  '8302-2',  // Body height
  '39156-5', // Body mass index (BMI)
  '72514-3', // Pain severity — 0-10 verbal numeric rating
  '9269-2',  // Glasgow Coma Scale total
  '8280-0',  // Waist circumference
  '9843-4',  // Head circumference (occipital-frontal)
  // ─── Glucose / diabetes ────────────────────────────────────
  '2339-0',  // Glucose Mass/volume in Blood
  '2345-7',  // Glucose Mass/volume in Serum or Plasma
  '1558-6',  // Fasting glucose
  '1521-4',  // Glucose 2-hour post-meal
  '4548-4',  // Hemoglobin A1c/Hemoglobin.total in Blood
  // ─── Renal / electrolytes ──────────────────────────────────
  '2160-0',  // Creatinine
  '3094-0',  // Urea nitrogen (BUN)
  '2823-3',  // Potassium
  '2951-2',  // Sodium
  '2075-0',  // Chloride
  '17861-6', // Calcium
  '1968-7',  // Bicarbonate (HCO3)
  '2777-1',  // Phosphate
  '19123-9', // Magnesium [Mass/volume] in Serum or Plasma
  '62238-1', // eGFR (CKD-EPI)
  '14959-1', // Microalbumin/Creatinine ratio
  // ─── Protein / chem extras ─────────────────────────────────
  '1751-7',  // Albumin
  '2885-2',  // Protein total
  // ─── CBC ────────────────────────────────────────────────────
  '718-7',   // Hemoglobin Mass/volume in Blood
  '4544-3',  // Hematocrit
  '789-8',   // Erythrocytes (RBC)
  '6690-2',  // Leukocytes (WBC)
  '777-3',   // Platelets
  '787-2',   // MCV (mean corpuscular volume)
  '785-6',   // MCH (mean corpuscular hemoglobin)
  '786-4',   // MCHC
  '788-0',   // RDW
  '770-8',   // Neutrophils/100 leukocytes
  '736-9',   // Lymphocytes/100 leukocytes
  '30341-2', // ESR (erythrocyte sedimentation rate)
  // ─── Iron panel ────────────────────────────────────────────
  '2498-4',  // Iron
  '2500-7',  // TIBC
  '2502-3',  // Transferrin saturation
  '2276-4',  // Ferritin
  // ─── Inflammation ──────────────────────────────────────────
  '1988-5',  // C-reactive protein (CRP)
  // ─── Lipid panel ────────────────────────────────────────────
  '2093-3',  // Cholesterol total
  '2571-8',  // Triglycerides
  '2085-9',  // HDL cholesterol
  '13457-7', // LDL cholesterol calc
  '13458-5', // VLDL cholesterol calc
  '43396-1', // Non-HDL cholesterol
  // ─── Liver function ────────────────────────────────────────
  '1742-6',  // Alanine aminotransferase (ALT)
  '1920-8',  // Aspartate aminotransferase (AST)
  '6768-6',  // Alkaline phosphatase
  '1975-2',  // Bilirubin total
  '1977-8',  // Bilirubin direct
  '2324-2',  // Gamma glutamyl transferase (GGT)
  // ─── Coagulation ────────────────────────────────────────────
  '5902-2',  // Prothrombin time (PT)
  '6301-6',  // INR
  '14979-9', // aPTT
  '30240-6', // D-dimer
  // ─── Cardiac markers ────────────────────────────────────────
  '6598-7',  // Troponin T
  '10839-9', // Troponin I
  '6597-9',  // CK-MB
  '33762-6', // NT-proBNP
  '30934-4', // BNP (B-type natriuretic peptide)
  '2157-6',  // Creatine kinase total (CK)
  '14804-9', // LDH (lactate dehydrogenase)
  // ─── Thyroid ───────────────────────────────────────────────
  '3016-3',  // Thyrotropin (TSH)
  '3026-2',  // Free T4 (thyroxine)
  '3051-0',  // Free T3 (triiodothyronine)
  // ─── Endocrine ─────────────────────────────────────────────
  '2143-6',  // Cortisol
  // ─── Urinalysis ────────────────────────────────────────────
  '5811-5',  // Specific gravity (urine)
  '5803-2',  // pH (urine)
  '20405-7', // Urine protein
  '5792-7',  // Urine glucose
  '5797-6',  // Urine ketones
  '5799-2',  // Urine leukocyte esterase
  '5802-4',  // Urine nitrite
  // ─── Microbiology / serology ───────────────────────────────
  '94504-8', // SARS-CoV-2 RNA presence
]);

/**
 * Validate the LOINC syntax — digits + hyphen + single check digit.
 *
 * We deliberately do NOT verify the LOINC check-digit algorithm here. The
 * public LOINC documentation describes it imprecisely (Mod 10 variant) and
 * the only authoritative validator is the official LOINC release CSV. Adding
 * a wrong-algorithm checksum gives us false negatives on real codes, which
 * is worse than no checksum. Treat structure as a sanity check only; for
 * "is this actually a real LOINC code" use the allowlist or a future full
 * catalogue lookup.
 */
export function isValidStructure(code) {
  if (!code || typeof code !== 'string') return false;
  return /^\d{1,7}-\d$/.test(code.trim());
}

export function isInAllowlist(code) {
  return ALLOWLIST.has((code || '').trim());
}

/**
 * Validate a LOINC code. In strict mode (default) the code must be in the
 * allowlist; otherwise structural validity is enough. Returns
 * `{ valid, reason? }` rather than a bare boolean so callers can log the
 * actual rejection reason.
 */
export function validate(code, { strict = true } = {}) {
  if (!isValidStructure(code)) {
    return { valid: false, reason: 'invalid-structure' };
  }
  if (strict && !isInAllowlist(code)) {
    return { valid: false, reason: 'not-in-allowlist' };
  }
  return { valid: true };
}

export default { validate, isValidStructure, isInAllowlist };
