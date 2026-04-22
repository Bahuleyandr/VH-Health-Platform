import { getJSON, postJSON, putJSON } from './core';

// Types
export interface Admission {
  id: number;
  encounter_id: string;
  patient_uid: string;
  patient_name?: string;
  admitting_doctor: string;
  department?: string;
  ward?: string;
  bed_number?: string;
  chief_complaint: string;
  admitting_diagnosis?: string;
  status: 'admitted' | 'transferred' | 'discharged' | 'lama' | 'expired';
  priority: 'routine' | 'urgent' | 'emergent';
  code_status: string;
  admitted_at: string;
  discharged_at?: string;
  actual_los_days?: number;
}

export interface ClinicalNote {
  id: number;
  patient_uid: string;
  author_uid: string;
  author_name?: string;
  note_type: 'soap' | 'progress' | 'procedure' | 'discharge' | 'nursing_assessment';
  content: Record<string, unknown>;
  is_signed: boolean;
  created_at: string;
}

export interface ClinicalOrder {
  id: number;
  order_number: string;
  patient_uid: string;
  order_type: 'medication' | 'investigation' | 'nursing' | 'diet' | 'activity';
  priority: string;
  status: string;
  details: Record<string, unknown>;
  ordered_by: string;
  created_at: string;
}

export interface AdmissionStats {
  totalActive: number;
  avgLOS: number;
  occupancyRate: number;
  dischargeBreakdown: Record<string, number>;
}

export interface ClinicalAiConfig {
  provider: string;
  model: string;
  enabled: boolean;
  baseUrlConfigured: boolean;
  apiKeyConfigured?: boolean;
  externalProvider?: boolean;
  externalAllowed?: boolean;
  readiness?: string | null;
  supportedProviders?: string[];
}

export interface ClinicalAiGeneration {
  id: number;
  patient_uid?: string;
  patient_name?: string;
  admission_id?: number;
  task_type: string;
  provider: string;
  model?: string;
  status: string;
  used_ai: boolean;
  safety_flags: Array<{ severity: string; code: string; message: string }>;
  created_at: string;
}

export interface ClinicalAiSafetyFlag {
  generation_id: number;
  patient_uid?: string;
  patient_name?: string;
  admission_id?: number;
  severity: string;
  code: string;
  message: string;
  created_at: string;
}

// API functions
export async function getActiveAdmissions(params?: { page?: number; limit?: number; ward?: string; status?: string }) {
  const query = new URLSearchParams();
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.ward) query.set('ward', params.ward);
  if (params?.status) query.set('status', params.status);
  return getJSON(`/emr/admissions?${query}`);
}

export async function getAdmissionDetail(id: number) { return getJSON(`/emr/admission/${id}`); }
export async function getAdmissionStats(dateFrom: string, dateTo: string) { return getJSON(`/emr/admissions/stats?date_from=${dateFrom}&date_to=${dateTo}`); }
export async function getPatientTimeline(uid: string) { return getJSON(`/emr/timeline/${uid}`); }
export async function getPatientNotes(uid: string) { return getJSON(`/emr/notes/patient/${uid}`); }
export async function getPatientOrders(uid: string) { return getJSON(`/emr/orders/patient/${uid}`); }
export async function getActiveProblemList(uid: string) { return getJSON(`/emr/diagnosis/patient/${uid}`); }
export async function getActiveAlerts(uid: string) { return getJSON(`/emr/cds/alerts/${uid}`); }
export async function searchICD10(query: string) { return getJSON(`/emr/icd10/search?q=${encodeURIComponent(query)}`); }
export async function getClinicalAiConfig() { return getJSON<ClinicalAiConfig>('/emr/clinical-ai/config'); }
export async function generateHandoverDraft(patientUid: string) {
  return postJSON('/clinical/handover/generate', { patient_uid: patientUid });
}
export async function createDowntimeSnapshot(patientUid: string, hoursToLive = 12) {
  return postJSON(`/emr/downtime-snapshot/${patientUid}`, { hours_to_live: hoursToLive });
}
export async function getClinicalAiGenerations() {
  return getJSON<{ generations: ClinicalAiGeneration[]; count: number }>('/admin/clinical-ai/generations');
}
export async function getClinicalAiSafetyFlags() {
  return getJSON<{ flags: ClinicalAiSafetyFlag[]; count: number }>('/admin/clinical-ai/safety-flags');
}

// Discharge Summary
export interface DischargeSummary {
  hospital_course: string;
  discharge_diagnosis: string;
  discharge_condition: string;
  medications_on_discharge: Array<{ name: string; dose: string; route: string; frequency: string; duration: string }>;
  follow_up_instructions: string;
  activity_restrictions: string;
  diet_instructions: string;
  warning_signs: string;
  procedures_performed: string[];
  investigations_summary: Array<{ test: string; status: string; result: string }>;
  generated_at: string;
  is_draft: boolean;
  is_signed: boolean;
  signed_by: string | null;
  signed_at: string | null;
}

export async function generateDischargeSummary(admissionId: number) {
  return postJSON(`/emr/${admissionId}/discharge-summary/generate`, {});
}
export async function saveDischargeSummary(admissionId: number, summary: Partial<DischargeSummary>) {
  return putJSON(`/emr/${admissionId}/discharge-summary`, { discharge_summary: summary });
}
export async function signDischargeSummary(admissionId: number) {
  return postJSON(`/emr/${admissionId}/discharge-summary/sign`, {});
}
