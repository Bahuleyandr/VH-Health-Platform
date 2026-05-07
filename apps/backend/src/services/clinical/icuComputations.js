// src/services/clinical/icuComputations.js — Sprint 19
//
// Pure compute helpers for ICU flowsheet + assessments + ABCDEF
// bundle. Extracted into a separate module so unit tests can import
// them without pulling in the prisma client.

export function gcsTotal(eye, verbal, motor) {
  if (eye == null && verbal == null && motor == null) return null;
  return (eye || 0) + (verbal || 0) + (motor || 0);
}

export function netBalance({ iv_fluids_ml, oral_intake_ml, blood_products_ml,
  urine_output_ml, drain_output_ml, ng_aspirate_ml }) {
  const intake = (iv_fluids_ml || 0) + (oral_intake_ml || 0) + (blood_products_ml || 0);
  const output = (urine_output_ml || 0) + (drain_output_ml || 0) + (ng_aspirate_ml || 0);
  return intake - output;
}

// CAM-ICU positive iff feature1 AND feature2 AND (feature3 OR feature4).
export function camPositive(f1, f2, f3, f4) {
  if (f1 == null || f2 == null) return null;
  return Boolean(f1) && Boolean(f2) && (Boolean(f3) || Boolean(f4));
}

export function bundleComplete(b) {
  return Boolean(b.a_awakening_done) &&
    Boolean(b.b_breathing_done) &&
    Boolean(b.c_choice_done) &&
    Boolean(b.d_delirium_assessed) &&
    Boolean(b.e_mobility_done) &&
    Boolean(b.f_family_done);
}

export function bundlePct(b) {
  const flags = [
    b.a_awakening_done, b.b_breathing_done, b.c_choice_done,
    b.d_delirium_assessed, b.e_mobility_done, b.f_family_done,
  ];
  const done = flags.filter(Boolean).length;
  return Math.round(100 * done / flags.length);
}
