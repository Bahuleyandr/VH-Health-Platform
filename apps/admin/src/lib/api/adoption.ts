import { apiFetch } from "../api-fetch";
import { getJSON, putJSON, type QueryParams } from "./core";

export interface HelpCenterCategory {
  id: number;
  tenant_id: string;
  category_key: string;
  label: string;
  description: string | null;
  role_scope: string[];
  sort_order: number;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LearningModule {
  id: number;
  tenant_id: string;
  module_key: string;
  title: string;
  module_type: string;
  category_key: string | null;
  summary: string | null;
  content_markdown: string;
  content_uri: string | null;
  role_scope: string[];
  required_for_roles: string[];
  status: string;
  version: number;
  estimated_minutes: number;
  no_phi: boolean;
  published_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TourDefinition {
  id: number;
  tenant_id: string;
  tour_key: string;
  title: string;
  surface: string;
  route_pattern: string | null;
  role_scope: string[];
  steps: Array<Record<string, unknown>>;
  status: string;
  version: number;
  resume_policy: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LearningCompletion {
  id: number;
  module_id: number;
  module_key: string;
  title: string;
  actor_uid: string;
  actor_role: string | null;
  module_version: number;
  status: string;
  completion_source: string;
  completed_at: string;
  evidence_metadata: Record<string, unknown>;
}

export interface TourEvent {
  id: number;
  tour_id: number;
  tour_key: string;
  title: string;
  actor_uid: string;
  actor_role: string | null;
  tour_version: number;
  event_type: string;
  step_key: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface TrainingEvidence {
  id: number;
  evidence_key: string;
  source_type: string;
  source_id: number | null;
  control_code: string;
  subject_uid: string;
  subject_role: string | null;
  title: string;
  evidence_status: string;
  evidence_uri: string | null;
  verified_by: string | null;
  verified_at: string | null;
  period_start: string | null;
  period_end: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AdoptionSummary {
  tenant_id: string;
  role: string | null;
  categories: HelpCenterCategory[];
  modules: LearningModule[];
  tours: TourDefinition[];
  recent_completions: LearningCompletion[];
  recent_tour_events: TourEvent[];
  evidence_ledger: TrainingEvidence[];
  evidence_counts: Array<{
    control_code: string;
    evidence_status: string;
    count: number;
  }>;
  counts: {
    categories: number;
    modules: number;
    tours: number;
    recent_completions: number;
    recent_tour_events: number;
    evidence_rows: number;
  };
  invariants: {
    no_phi_training_content: boolean;
    rich_course_authoring: boolean;
    evidence_control: string;
  };
}

export interface HelpCategoryPayload {
  category_key: string;
  label: string;
  description?: string | null;
  role_scope?: string[];
  sort_order?: number;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface LearningModulePayload {
  module_key: string;
  title: string;
  module_type?: string;
  category_key?: string | null;
  summary?: string | null;
  content_markdown?: string;
  content_uri?: string | null;
  role_scope?: string[];
  required_for_roles?: string[];
  status?: string;
  version?: number;
  estimated_minutes?: number;
  metadata?: Record<string, unknown>;
}

export interface TourPayload {
  tour_key: string;
  title: string;
  surface: string;
  route_pattern?: string | null;
  role_scope?: string[];
  steps?: Array<Record<string, unknown>>;
  status?: string;
  version?: number;
  resume_policy?: string;
  metadata?: Record<string, unknown>;
}

export function getAdoptionSummary() {
  return getJSON<AdoptionSummary>("/admin/adoption");
}

export function saveHelpCategory(payload: HelpCategoryPayload) {
  return putJSON<HelpCenterCategory>("/admin/adoption/help-categories", payload);
}

export function saveLearningModule(payload: LearningModulePayload) {
  return putJSON<LearningModule>("/admin/adoption/modules", payload);
}

export function saveTourDefinition(payload: TourPayload) {
  return putJSON<TourDefinition>("/admin/adoption/tours", payload);
}

export async function downloadTrainingEvidenceCsv(params?: QueryParams) {
  const search = new URLSearchParams({ format: "csv" });
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const res = await apiFetch(`/api/v1/admin/adoption/evidence-ledger?${search.toString()}`);
  if (!res.ok) {
    throw new Error(`Evidence export failed with HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "training-evidence-ledger.csv";
  a.click();
  URL.revokeObjectURL(url);
}
