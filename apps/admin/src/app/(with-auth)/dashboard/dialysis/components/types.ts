// src/app/(with-auth)/dashboard/dialysis/components/types.ts

export interface DialysisPatient {
  id: number;
  patient_uid: string;
  enrolled_at: string;
  modality: string;
  schedule_pattern: string | null;
  prescribed_minutes: number | null;
  prescribed_dialyser: string | null;
  dry_weight_kg: string | null;
  dry_weight_set_at: string | null;
  anticoag_default: string;
  hbsag_status: string;
  hcv_status: string;
  hiv_status: string;
  isolation_required: boolean;
  status: string;
}

export interface VascularAccess {
  id: number;
  access_type: string;
  side: string | null;
  created_date: string;
  first_used_date: string | null;
  active: boolean;
  abandoned_date: string | null;
  abandoned_reason: string | null;
  last_qa_check_date: string | null;
  qa_flow_ml_min: number | null;
}

export interface SessionRow {
  id: number;
  dialysis_patient_id: number;
  vascular_access_id: number | null;
  session_date: string;
  machine_no: string | null;
  station_no: string | null;
  modality: string;
  scheduled_start_at: string | null;
  actual_start_at: string | null;
  actual_end_at: string | null;
  duration_min: number | null;
  pre_weight_kg: string | null;
  post_weight_kg: string | null;
  prescribed_uf_l: string | null;
  actual_uf_l: string | null;
  ktv_calculated: string | null;
  urr_pct: number | null;
  intra_dialytic_hypotension: boolean;
  cramps: boolean;
  early_termination: boolean;
  status: string;
  notes: string | null;
}

export interface TodayRow {
  session_id: number;
  dialysis_patient_id: number;
  station_no: string | null;
  machine_no: string | null;
  scheduled_start_at: string | null;
  actual_start_at: string | null;
  actual_end_at: string | null;
  status: string;
  patient_uid: string;
  modality: string;
  isolation_required: boolean;
  access_type: string | null;
  intra_dialytic_hypotension: boolean;
  cramps: boolean;
}

export interface IntraObs {
  id: number;
  recorded_at: string;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  pulse: number | null;
  spo2: number | null;
  temp_c: string | null;
  blood_flow_ml_min: number | null;
  uf_rate_ml_hr: number | null;
  tmp_mmhg: number | null;
  arterial_pressure: number | null;
  venous_pressure: number | null;
  uf_total_ml: number | null;
  event_note: string | null;
  intervention: string | null;
  intervention_dose: string | null;
}

export interface SerologyRow {
  id: number;
  test_date: string;
  hbsag: string | null;
  hbs_titre: string | null;
  anti_hcv: string | null;
  hcv_pcr: string | null;
  hiv: string | null;
  is_seroconversion: boolean;
}

export interface AdequacySummary {
  sessions_30d: number;
  adequacy_measurements: number;
  mean_ktv: string | null;
  mean_urr_pct: string | null;
  hypotension_episodes: number;
  early_terms: number;
}

export interface PatientDetail extends DialysisPatient {
  access: VascularAccess[];
  recent_sessions: SessionRow[];
  serology: SerologyRow[];
  adequacy_30d: AdequacySummary | null;
}

export function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

export function unwrapList<T>(r: unknown): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  return Array.isArray(data) ? (data as T[]) : [];
}

export function fmtTime(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit",
  });
}
