/**
 * G3 outcome instrumentation client.
 *
 *   GET /admin/clinical-ai/outcome-scoreboard
 *
 * Read-only per-module AI evidence scoreboard (acceptance rate, edit
 * distance, override rate, time-to-sign vs baseline, safety-flag
 * precision) computed server-side from the existing generation / review /
 * safety tables. Rates arrive as null when there is no data to rate —
 * render them as "no evidence yet", never as 0%.
 */

import { getJSON } from "./core";

export interface ScoreboardGenerations {
  total: number;
  ai_generated: number;
  fallback: number;
}

export interface ScoreboardReviews {
  total: number;
  decided: number;
  pending: number;
  accepted: number;
  edited: number;
  rejected: number;
  needs_revision: number;
  acceptance_rate_pct: number | null;
  used_rate_pct: number | null;
  avg_review_latency_minutes: number | null;
}

export interface ScoreboardEdits {
  sample_count: number;
  mean_edit_distance_pct: number | null;
  median_edit_distance_pct: number | null;
}

export interface ScoreboardSafety {
  flagged_total: number;
  flagged_decided: number;
  flagged_confirmed: number;
  flagged_overridden: number;
  flag_precision_pct: number | null;
  flag_override_rate_pct: number | null;
  missed_reject_count: number;
}

export interface ScoreboardTimeToSign {
  note_type: string;
  ai_signed_count: number;
  ai_median_minutes: number | null;
  ai_avg_minutes: number | null;
  baseline_signed_count: number;
  baseline_median_minutes: number | null;
  baseline_avg_minutes: number | null;
  median_delta_minutes: number | null;
}

export interface ScoreboardModuleRow {
  module_key: string;
  display_name: string | null;
  enabled: boolean;
  generations: ScoreboardGenerations;
  reviews: ScoreboardReviews;
  edits: ScoreboardEdits;
  safety: ScoreboardSafety;
  time_to_sign: ScoreboardTimeToSign[];
}

export interface ScoreboardMedicationSafetyRow {
  review_type: string;
  finding_count: number;
  critical_count: number;
  blocker_count: number;
  overridden_count: number;
  override_rate_pct: number | null;
}

export interface ScoreboardMedicationSafety {
  finding_count: number;
  critical_count: number;
  blocker_count: number;
  overridden_count: number;
  override_rate_pct: number | null;
  by_type: ScoreboardMedicationSafetyRow[];
}

export interface ScoreboardTotals {
  modules_with_activity: number;
  generations: ScoreboardGenerations;
  reviews: ScoreboardReviews;
  edits: ScoreboardEdits;
  safety: Omit<ScoreboardSafety, "missed_reject_count"> & { missed_reject_count: number };
  time_to_sign: {
    ai_signed_count: number;
    baseline_signed_count: number;
    ai_avg_minutes: number | null;
    baseline_avg_minutes: number | null;
  };
}

export interface AiOutcomeScoreboard {
  tenant_id: string;
  period_start: string;
  period_end: string;
  period_days: number;
  module_key: string;
  modules: ScoreboardModuleRow[];
  totals: ScoreboardTotals;
  medication_safety: ScoreboardMedicationSafety;
  definitions: Record<string, string>;
  computed_at: string;
  decision_support_only: boolean;
  read_only: boolean;
}

export async function getAiOutcomeScoreboard(params: {
  periodDays?: number;
  moduleKey?: string;
} = {}) {
  const query: Record<string, string> = {};
  if (params.periodDays) query.period_days = String(params.periodDays);
  if (params.moduleKey) query.module_key = params.moduleKey;
  return getJSON<AiOutcomeScoreboard>("/admin/clinical-ai/outcome-scoreboard", query);
}
