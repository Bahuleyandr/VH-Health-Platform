import { apiFetch } from "../api-fetch";
import { fetchAdminAPI, getJSON, postJSON, putJSON, type QueryParams } from "./core";

export type CareTeamKind =
  | "op"
  | "ip"
  | "er"
  | "icu"
  | "day_care"
  | "dialysis"
  | "perioperative"
  | "longitudinal"
  | "other";

export type CareTeamStatus = "active" | "paused" | "closed" | "archived";
export type CareTeamMemberStatus = "active" | "inactive" | "suspended" | "ended";
export type SpecimenStatus =
  | "ordered"
  | "collected"
  | "in_transit"
  | "received"
  | "processing"
  | "rejected"
  | "disposed"
  | "cancelled";
export type AnalyzerStatus = "active" | "maintenance" | "offline" | "retired";
export type QcResultStatus = "pending" | "passed" | "failed" | "warning";

export interface CareTeam {
  id: number;
  tenant_id: string;
  patient_uid: string;
  admission_id: number | null;
  appointment_id: number | null;
  team_kind: CareTeamKind;
  display_name: string | null;
  primary_department: string | null;
  status: CareTeamStatus;
  status_reason: string | null;
  updated_at: string;
  created_at: string;
}

export interface CareTeamMember {
  id: number;
  care_team_id: number;
  patient_uid: string;
  staff_uid: string | null;
  staff_id: number | null;
  staff_role: string | null;
  member_name: string | null;
  relationship_kind: string;
  break_glass_allowed: boolean;
  status: CareTeamMemberStatus;
  active_from: string | null;
  active_until: string | null;
  notes: string | null;
}

export interface PatientAccessAuditEvent {
  id: number;
  patient_uid: string | null;
  actor_uid: string | null;
  actor_role: string | null;
  record_type: string | null;
  access_reason: string | null;
  access_decision: string | null;
  access_source: string | null;
  route: string | null;
  action: string | null;
  resource_type: string | null;
  policy_code: string | null;
  created_at: string;
}

export interface PatientAccessShadowDenialRow {
  day: string;
  actor_role: string;
  resource_family: string;
  denial_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface PatientAccessShadowDenialsReport {
  range: {
    date_from: string | null;
    date_to: string | null;
  };
  shadow_denials: PatientAccessShadowDenialRow[];
  count: number;
  total_denials: number;
}

export interface PatientBreakGlassSession {
  id: number;
  patient_uid: string;
  actor_uid: string;
  actor_role: string | null;
  reason: string;
  status: string;
  expires_at: string | null;
  created_at: string;
}

export interface LabSpecimen {
  id: number;
  patient_uid: string;
  booking_id: number | null;
  accession_number: string;
  specimen_type: string;
  container_type: string | null;
  collection_site: string | null;
  priority: string;
  status: SpecimenStatus;
  status_reason: string | null;
  collected_at: string | null;
  received_at: string | null;
  rejected_at: string | null;
  created_at: string;
}

export interface LabAnalyzer {
  id: number;
  analyzer_code: string;
  display_name: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  interface_kind: string;
  status: AnalyzerStatus;
  updated_at: string;
}

export interface LabQcRun {
  id: number;
  analyzer_id: number;
  qc_level: string;
  qc_lot_number: string | null;
  result_status: QcResultStatus;
  measured_values: Record<string, unknown>;
  performed_at: string | null;
  performed_by: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  notes: string | null;
}

export function listCareTeams(params: {
  patient_uid?: string;
  admission_id?: number | string;
  appointment_id?: number | string;
  status?: CareTeamStatus | "";
  limit?: number;
} = {}) {
  return getJSON<{ care_teams: CareTeam[]; count: number }>(
    "/admin/clinical-governance/care-teams",
    params,
  );
}

export function createCareTeam(payload: {
  patient_uid: string;
  team_kind?: CareTeamKind;
  display_name?: string | null;
  primary_department?: string | null;
  admission_id?: number | null;
  appointment_id?: number | null;
}) {
  return postJSON<CareTeam>("/admin/clinical-governance/care-teams", payload);
}

export function transitionCareTeam(id: number, payload: {
  next_status: CareTeamStatus;
  reason?: string | null;
}) {
  return fetchAdminAPI<CareTeam>(`/admin/clinical-governance/care-teams/${id}/transition`, {
    method: "PATCH",
    body: payload,
  });
}

export function listCareTeamMembers(careTeamId: number, params: {
  status?: CareTeamMemberStatus | "";
  limit?: number;
} = {}) {
  return getJSON<{ members: CareTeamMember[]; count: number }>(
    `/admin/clinical-governance/care-teams/${careTeamId}/members`,
    params,
  );
}

export function addCareTeamMember(careTeamId: number, payload: {
  staff_uid?: string | null;
  staff_id?: number | null;
  staff_role?: string | null;
  member_name?: string | null;
  relationship_kind?: string;
  break_glass_allowed?: boolean;
  notes?: string | null;
}) {
  return postJSON<CareTeamMember>(
    `/admin/clinical-governance/care-teams/${careTeamId}/members`,
    payload,
  );
}

export function transitionCareTeamMember(careTeamId: number, memberId: number, payload: {
  next_status: CareTeamMemberStatus;
  reason?: string | null;
}) {
  return fetchAdminAPI<CareTeamMember>(
    `/admin/clinical-governance/care-teams/${careTeamId}/members/${memberId}/transition`,
    {
      method: "PATCH",
      body: payload,
    },
  );
}

export function listPatientAccessAudit(params: {
  patient_uid?: string;
  actor_uid?: string;
  decision?: string;
  source?: string;
  action?: string;
  record_type?: string;
  resource_type?: string;
  route?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
} = {}) {
  return getJSON<{ access_events: PatientAccessAuditEvent[]; count: number }>(
    "/admin/clinical-governance/patient-access/audit",
    params,
  );
}

function buildQueryString(params: QueryParams): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export function listPatientAccessShadowDenials(params: {
  date_from?: string;
  date_to?: string;
} = {}) {
  return getJSON<PatientAccessShadowDenialsReport>(
    "/admin/clinical-governance/patient-access/shadow-denials",
    params,
  );
}

export async function downloadPatientAccessShadowDenialsCsv(params: {
  date_from?: string;
  date_to?: string;
} = {}) {
  const res = await apiFetch(
    `/api/v1/admin/clinical-governance/patient-access/shadow-denials${buildQueryString({
      ...params,
      format: "csv",
    })}`,
    { method: "GET", headers: { Accept: "text/csv" } },
  );
  if (!res.ok) {
    throw new Error(`CSV export failed with HTTP ${res.status}`);
  }
  return res.blob();
}

export function startPatientBreakGlass(payload: {
  patient_uid: string;
  actor_uid: string;
  actor_role?: string | null;
  reason: string;
  expires_at?: string | null;
}) {
  return postJSON<PatientBreakGlassSession>(
    "/admin/clinical-governance/patient-access/break-glass",
    payload,
  );
}

export function listLabSpecimens(params: {
  patient_uid?: string;
  booking_id?: number | string;
  status?: SpecimenStatus | "";
  limit?: number;
} = {}) {
  return getJSON<{ specimens: LabSpecimen[]; count: number }>(
    "/admin/clinical-governance/lab/specimens",
    params,
  );
}

export function createLabSpecimen(payload: {
  patient_uid: string;
  accession_number: string;
  specimen_type?: string;
  priority?: string;
  container_type?: string | null;
  collection_site?: string | null;
}) {
  return postJSON<LabSpecimen>("/admin/clinical-governance/lab/specimens", payload);
}

export function transitionLabSpecimen(id: number, payload: {
  next_status: SpecimenStatus;
  reason?: string | null;
}) {
  return fetchAdminAPI<LabSpecimen>(
    `/admin/clinical-governance/lab/specimens/${id}/transition`,
    {
      method: "PATCH",
      body: payload,
    },
  );
}

export function listLabAnalyzers(params: {
  status?: AnalyzerStatus | "";
  facility_id?: number | string;
  limit?: number;
} = {}) {
  return getJSON<{ analyzers: LabAnalyzer[]; count: number }>(
    "/admin/clinical-governance/lab/analyzers",
    params,
  );
}

export function saveLabAnalyzer(payload: {
  id?: number | null;
  analyzer_code: string;
  display_name: string;
  manufacturer?: string | null;
  model?: string | null;
  serial_number?: string | null;
  interface_kind?: string;
  status?: AnalyzerStatus;
}) {
  return putJSON<LabAnalyzer>("/admin/clinical-governance/lab/analyzers", payload);
}

export function listLabQcRuns(analyzerId: number, params: {
  result_status?: QcResultStatus | "";
  limit?: number;
} = {}) {
  return getJSON<{ qc_runs: LabQcRun[]; count: number }>(
    `/admin/clinical-governance/lab/analyzers/${analyzerId}/qc-runs`,
    params,
  );
}

export function recordLabQcRun(analyzerId: number, payload: {
  qc_level?: string;
  qc_lot_number?: string | null;
  result_status?: QcResultStatus;
  measured_values?: Record<string, unknown>;
  notes?: string | null;
}) {
  return postJSON<LabQcRun>(
    `/admin/clinical-governance/lab/analyzers/${analyzerId}/qc-runs`,
    payload,
  );
}
