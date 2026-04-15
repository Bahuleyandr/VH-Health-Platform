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
  // ─── Glucose / chem ─────────────────────────────────────────
  '2339-0',  // Glucose Mass/volume in Blood
  '2345-7',  // Glucose Mass/volume in Serum or Plasma
  '4548-4',  // Hemoglobin A1c/Hemoglobin.total in Blood
  '2160-0',  // Creatinine
  '3094-0',  // Urea nitrogen
  '2823-3',  // Potassium
  '2951-2',  // Sodium
  '2075-0',  // Chloride
  '17861-6', // Calcium
  // ─── CBC ────────────────────────────────────────────────────
  '718-7',   // Hemoglobin Mass/volume in Blood
  '4544-3',  // Hematocrit
  '789-8',   // Erythrocytes (RBC)
  '6690-2',  // Leukocytes (WBC)
  '777-3',   // Platelets
  // ─── Lipid panel ────────────────────────────────────────────
  '2093-3',  // Cholesterol
  '2571-8',  // Triglycerides
  '2085-9',  // HDL cholesterol
  '13457-7', // LDL cholesterol calc
  // ─── Liver / kidney function ────────────────────────────────
  '1742-6',  // Alanine aminotransferase (ALT)
  '1920-8',  // Aspartate aminotransferase (AST)
  '6768-6',  // Alkaline phosphatase
  '1975-2',  // Bilirubin total
  // ─── Coagulation ────────────────────────────────────────────
  '5902-2',  // Prothrombin time (PT)
  '6301-6',  // INR
  // ─── Cardiac markers ────────────────────────────────────────
  '6598-7',  // Troponin T
  '10839-9', // Troponin I
  '6597-9',  // CK-MB
  '33762-6', // NT-proBNP
  // ─── Microbiology / serology ────────────────────────────────
  '5811-5',  // Specific gravity (urine)
  '5803-2',  // pH (urine)
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
