// src/app/(with-auth)/dashboard/icu/components/types.ts

export interface IcuAdmission {
  id: number;
  patient_uid: string;
  unit_code: string;
  bed_no: string | null;
  admitted_at: string;
  admitting_doctor_name: string | null;
  primary_diagnosis: string | null;
  reason_for_icu: string | null;
  apache_ii_score: number | null;
  sofa_score: number | null;
  predicted_mortality_pct: number | null;
  expected_los_days: number | null;
  code_status: "full_code" | "dni" | "dnr" | "dnr_dni" | "comfort_only";
  code_status_set_at: string | null;
  status: "active" | "discharged" | "transferred" | "expired";
  discharged_at: string | null;
  discharge_disposition: string | null;
  outcome_notes: string | null;
}

export interface FlowsheetEntry {
  id: number;
  recorded_at: string;
  hr: number | null;
  sbp: number | null;
  dbp: number | null;
  map: number | null;
  cvp: number | null;
  spo2: number | null;
  rr: number | null;
  temp_c: number | null;
  cap_refill_sec: number | null;
  gcs_eye: number | null;
  gcs_verbal: number | null;
  gcs_motor: number | null;
  gcs_total: number | null;
  pupils_left_size_mm: number | null;
  pupils_right_size_mm: number | null;
  pupils_reactive: string | null;
  vent_mode: string | null;
  fio2_pct: number | null;
  peep_cmh2o: number | null;
  tidal_volume_ml: number | null;
  resp_rate_set: number | null;
  airway_pressure_peak: number | null;
  airway_pressure_plateau: number | null;
  pf_ratio: number | null;
  noradrenaline_mcg_kg_min: number | null;
  adrenaline_mcg_kg_min: number | null;
  vasopressin_units_hr: number | null;
  dobutamine_mcg_kg_min: number | null;
  propofol_mcg_kg_min: number | null;
  midazolam_mg_hr: number | null;
  fentanyl_mcg_hr: number | null;
  insulin_units_hr: number | null;
  iv_fluids_ml: number | null;
  oral_intake_ml: number | null;
  blood_products_ml: number | null;
  urine_output_ml: number | null;
  drain_output_ml: number | null;
  ng_aspirate_ml: number | null;
  net_balance_ml: number | null;
  event_note: string | null;
  recorded_by_name: string | null;
}

export interface IcuAssessment {
  id: number;
  recorded_at: string;
  assessment_kind: "rass" | "cam_icu" | "sofa" | "cpot";
  rass_score: number | null;
  rass_target: number | null;
  cam_feature_1: boolean | null;
  cam_feature_2: boolean | null;
  cam_feature_3: boolean | null;
  cam_feature_4: boolean | null;
  cam_positive: boolean | null;
  sofa_resp: number | null;
  sofa_coag: number | null;
  sofa_liver: number | null;
  sofa_cardio: number | null;
  sofa_cns: number | null;
  sofa_renal: number | null;
  sofa_total: number | null;
  cpot_facial: number | null;
  cpot_movement: number | null;
  cpot_muscle_tension: number | null;
  cpot_vent_compliance: number | null;
  cpot_total: number | null;
  notes: string | null;
}

export interface IcuBundle {
  id: number;
  bundle_date: string;
  a_awakening_done: boolean;
  a_awakening_reason_skipped: string | null;
  b_breathing_done: boolean;
  b_breathing_reason_skipped: string | null;
  b_breathing_outcome: string | null;
  c_choice_done: boolean;
  c_protocol_followed: boolean | null;
  d_delirium_assessed: boolean;
  d_delirium_positive: boolean | null;
  d_delirium_managed: boolean | null;
  e_mobility_done: boolean;
  e_mobility_level: string | null;
  e_mobility_reason_skipped: string | null;
  f_family_done: boolean;
  f_family_method: string | null;
  bundle_complete: boolean;
  bundle_pct: number | null;
  notes: string | null;
}

export interface IoSummaryRow {
  icu_admission_id: number;
  day: string;
  iv_fluids_ml: number;
  oral_intake_ml: number;
  blood_products_ml: number;
  urine_output_ml: number;
  drain_output_ml: number;
  ng_aspirate_ml: number;
  net_balance_ml: number;
  entries_logged: number;
}

export function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

export function unwrapList<T>(r: unknown): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  return Array.isArray(data) ? (data as T[]) : [];
}

export function fmtDateTime(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}
