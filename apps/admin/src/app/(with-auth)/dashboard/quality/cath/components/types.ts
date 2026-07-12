// NL13-P1f — cath quality views (dose rollups + complication registry).

export type ThresholdsStatus = "configured" | "thresholds_pending";

export type DoseThresholds = {
  fluoro_time_alert_min: number | null;
  dap_alert_gy_cm2: number | null;
  air_kerma_alert_mgy: number | null;
  contrast_volume_alert_ml: number | null;
  notes?: string | null;
  configured_at?: string | null;
};

export type DoseSettingsResponse = {
  thresholds_status: ThresholdsStatus;
  configured: boolean;
  settings: DoseThresholds | null;
};

export type DoseRollupRow = {
  bucket: string;
  case_count: number;
  record_count: number;
  total_fluoro_time_min: number | null;
  avg_fluoro_time_min: number | null;
  total_dap_gy_cm2: number | null;
  avg_dap_gy_cm2: number | null;
  total_air_kerma_mgy: number | null;
  total_contrast_ml: number | null;
  avg_contrast_ml: number | null;
  breach_count: number | null;
};

export type DoseRollupResponse = {
  period: { from: string; to: string };
  group_by: "month" | "operator";
  thresholds_status: ThresholdsStatus;
  thresholds: DoseThresholds | null;
  rows: DoseRollupRow[];
};

export type RegistryEntry = {
  id: number;
  case_id: number;
  procedure_log_id: number | null;
  patient_uid: string;
  patient_name: string | null;
  complication_code: string | null;
  complication_category: string;
  description: string | null;
  severity: string;
  outcome: string | null;
  review_status: string;
  review_notes: string | null;
  reviewed_at: string | null;
  occurred_at: string | null;
  source: string;
  created_at: string;
  requested_procedure: string;
  urgency: string;
};

export type RegistryResponse = {
  entries: RegistryEntry[];
  count: number;
};

export const REVIEW_STATUSES = ["open", "under_review", "reviewed", "closed"] as const;
export const SEVERITIES = ["unspecified", "minor", "moderate", "severe", "fatal"] as const;
export const OUTCOMES = ["resolved", "ongoing", "sequelae", "death", "unknown"] as const;
