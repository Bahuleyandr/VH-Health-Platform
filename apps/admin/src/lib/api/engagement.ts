// src/lib/api/engagement.ts
// NL9 patient-engagement campaign authoring API (backend:
// apps/backend/src/routes/engagement/engagementRoutes.js, mounted at
// /api/v1/engagement).
//
// Contract notes:
// - Reads and writes are separate modules server-side: the campaign state
//   machine lives in services/engagement/engagementCampaignService.js and the
//   three tenant-scoped list/read queries in
//   routes/engagement/engagementListQueries.js. Listing a campaign therefore
//   cannot fail an approval or a queue-due.
// - Safety order is enforced server-side: draft -> dry-run -> submit-approval
//   -> approve (scheduled) -> queue-due. The UI must gate its buttons on
//   campaign status and surface backend refusals verbatim.
// - Approval is ROLE-gated, not person-gated: the backend checks the actor's
//   role against the campaign's `approval_required_role` and records who
//   approved. Nothing here should claim a different-person rule.

import { getJSON, postJSON, putJSON, type QueryParams } from "./core";

export const ENGAGEMENT_CAMPAIGN_TYPES = [
  "appointment_recall",
  "no_show_recall",
  "feedback_nps_request",
  "generic_follow_up_reminder",
  "rpm_enrollment_reminder",
] as const;
export type EngagementCampaignType = (typeof ENGAGEMENT_CAMPAIGN_TYPES)[number];

export const ENGAGEMENT_CHANNELS = [
  "push",
  "sms",
  "whatsapp",
  "email",
  "inapp",
] as const;
export type EngagementChannel = (typeof ENGAGEMENT_CHANNELS)[number];

/** Whitelist enforced by the backend (ENGAGEMENT_TEMPLATE_VARIABLE_BLOCKED). */
export const ENGAGEMENT_TEMPLATE_VARIABLES = [
  "first_name",
  "salutation",
  "appointment_window",
  "department_name",
  "clinic_name",
  "call_to_action_url",
  "support_phone",
  "campaign_token",
  "feedback_link",
  "tenant_name",
] as const;

export const ENGAGEMENT_CAMPAIGN_STATUSES = [
  "draft",
  "dry_run",
  "pending_approval",
  "scheduled",
  "running",
  "paused",
  "completed",
  "archived",
  "cancelled",
] as const;
export type EngagementCampaignStatus =
  (typeof ENGAGEMENT_CAMPAIGN_STATUSES)[number];

export interface EngagementSettings {
  tenant_id: string;
  enabled: boolean;
  enabled_at?: string | null;
  enabled_by?: string | null;
  acceptance_snapshot: Record<string, unknown> | null;
  emergency_stop: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  tenant_daily_cap: number;
  per_patient_cooldown_hours: number;
  consent_max_age_days: number;
  channel_caps: Record<string, number>;
  default_consent_map: Record<string, string>;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface EngagementSettingsPatch {
  enabled?: boolean;
  /** Required by the backend whenever enabled=true. */
  acceptance_snapshot?: Record<string, unknown> | null;
  emergency_stop?: boolean;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  tenant_daily_cap?: number;
  per_patient_cooldown_hours?: number;
  consent_max_age_days?: number;
  channel_caps?: Record<string, number>;
  default_consent_map?: Record<string, string>;
}

export interface EngagementTemplate {
  id: number;
  tenant_id: string;
  notification_template_id: number;
  template_kind: EngagementCampaignType;
  channel: EngagementChannel;
  variables_schema: Record<string, unknown>;
  allowed_variables: string[];
  phi_classification: string;
  locale: string;
  approved_by: string | null;
  approved_at: string | null;
  retired_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EngagementTemplatePayload {
  template_kind: EngagementCampaignType;
  channel: EngagementChannel;
  notification_template_id: number;
  allowed_variables?: string[];
  variables_schema?: Record<string, unknown>;
  phi_classification?: string;
  locale?: string;
  /** Defaults to true server-side; pass false to create unapproved. */
  approved?: boolean;
}

export interface EngagementCampaign {
  id: number;
  tenant_id: string;
  campaign_type: EngagementCampaignType;
  objective: string;
  status: EngagementCampaignStatus;
  template_id: number;
  channels: EngagementChannel[];
  schedule_policy: Record<string, unknown>;
  rate_policy: Record<string, unknown>;
  audience_kind: "cohort" | "broad";
  approval_required_role: "care_team" | "admin_quality";
  created_by?: string | null;
  submitted_by?: string | null;
  submitted_at?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  scheduled_at: string | null;
  /** Present on rows read back through GET; POST returns them too when set. */
  started_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  frozen_audience_hash?: string | null;
  current_audience_snapshot_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface EngagementCampaignPayload {
  campaign_type: EngagementCampaignType;
  template_id: number;
  objective: string;
  channels?: EngagementChannel[];
  audience_kind?: "cohort" | "broad";
  schedule_policy?: Record<string, unknown>;
  rate_policy?: Record<string, unknown>;
  scheduled_at?: string | null;
}

export interface CampaignCandidate {
  patient_uid: string;
  channel?: EngagementChannel;
  variables?: Record<string, string>;
  due_at?: string;
}

export interface CampaignCandidateInput {
  patients: CampaignCandidate[];
  cohort_source?: Record<string, unknown>;
}

export interface AudienceSnapshot {
  id: number;
  tenant_id: string;
  campaign_id: number;
  snapshot_kind: "dry_run" | "materialized";
  cohort_source: Record<string, unknown>;
  cohort_hash: string;
  materialized_count: number;
  eligible_count: number;
  suppressed_count: number;
  source_tables: string[];
  minimum_cohort_size: number;
  created_by: string | null;
  created_at: string;
}

export interface AudienceCounts {
  materialized: number;
  eligible: number;
  suppressed: number;
}

/** Per-candidate verdict from the dry-run evaluator. */
export interface DryRunRecipient {
  eligible: boolean;
  /** Suppression reason (e.g. missing_consent, quiet_hours, patient_cooldown). */
  reason: string | null;
  patient_uid: string | null;
  channel?: EngagementChannel;
  required_consent_type?: string;
  consent_id?: number | null;
  contact_route?: string | null;
  variables?: Record<string, string>;
  due_at?: string;
  idempotency_key?: string;
}

export interface CampaignDryRunResult {
  snapshot: AudienceSnapshot;
  counts: AudienceCounts;
  recipients: DryRunRecipient[];
}

export interface MaterializedRecipient {
  id: number;
  tenant_id: string;
  campaign_id: number;
  audience_snapshot_id: number;
  patient_uid: string;
  consent_id: number | null;
  required_consent_type: string;
  channel: EngagementChannel;
  contact_route: string | null;
  due_at: string;
  status:
    "eligible" | "suppressed" | "queued" | "sent" | "failed" | "cancelled";
  suppression_reason: string | null;
  outbox_id: number | null;
  idempotency_key: string;
  variables: Record<string, string>;
  materialized_at: string | null;
  queued_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignMaterializeResult {
  snapshot: AudienceSnapshot;
  counts: AudienceCounts;
  recipients: MaterializedRecipient[];
}

export interface QueueDueResult {
  claimed: number;
  queued: number;
  suppressed: number;
  failed: number;
}

/** Shape of `buildPagination` (apps/backend/src/utils/listQuery.js). */
export interface EngagementPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface EngagementCampaignPage {
  campaigns: EngagementCampaign[];
  pagination: EngagementPagination;
}

export interface EngagementTemplatePage {
  templates: EngagementTemplate[];
  pagination: EngagementPagination;
}

/** Sort keys the campaign list accepts; anything else falls back to created_at. */
export const ENGAGEMENT_CAMPAIGN_SORT_FIELDS = [
  "created_at",
  "updated_at",
  "scheduled_at",
  "status",
] as const;

export interface EngagementCampaignListParams {
  status?: EngagementCampaignStatus;
  campaign_type?: EngagementCampaignType;
  page?: number;
  /** Server caps this at 100. */
  limit?: number;
  sortBy?: (typeof ENGAGEMENT_CAMPAIGN_SORT_FIELDS)[number];
  sortOrder?: "ASC" | "DESC";
}

export interface EngagementTemplateListParams {
  template_kind?: EngagementCampaignType;
  channel?: EngagementChannel;
  /** Retired templates are hidden unless this is true. */
  include_retired?: boolean;
  page?: number;
  limit?: number;
}

export function getEngagementSettings() {
  return getJSON<EngagementSettings>("/engagement/settings");
}

/**
 * Tenant-scoped campaign list — the read that makes a campaign parked in
 * `pending_approval` findable by an approver who did not submit it. An unknown
 * `status`/`campaign_type` is refused by the backend (400) rather than
 * silently returning an empty page, so the filters here are typed to the
 * enums the server accepts.
 */
export function listEngagementCampaigns(
  params: EngagementCampaignListParams = {},
) {
  return getJSON<EngagementCampaignPage>(
    "/engagement/campaigns",
    params as QueryParams,
  );
}

/** Single campaign by id — lets an approver open one straight from a link. */
export function getEngagementCampaign(campaignId: number) {
  return getJSON<EngagementCampaign>(`/engagement/campaigns/${campaignId}`);
}

/** Tenant-scoped template list; retired templates are excluded by default. */
export function listEngagementTemplates(
  params: EngagementTemplateListParams = {},
) {
  return getJSON<EngagementTemplatePage>(
    "/engagement/templates",
    params as QueryParams,
  );
}

export function updateEngagementSettings(patch: EngagementSettingsPatch) {
  return putJSON<EngagementSettings>("/engagement/settings", patch);
}

export function createEngagementTemplate(payload: EngagementTemplatePayload) {
  return postJSON<EngagementTemplate>("/engagement/templates", payload);
}

export function createEngagementCampaign(payload: EngagementCampaignPayload) {
  return postJSON<EngagementCampaign>("/engagement/campaigns", payload);
}

export function dryRunCampaign(
  campaignId: number,
  input: CampaignCandidateInput,
) {
  return postJSON<CampaignDryRunResult>(
    `/engagement/campaigns/${campaignId}/dry-run`,
    input,
  );
}

export function materializeCampaignRecipients(
  campaignId: number,
  input: CampaignCandidateInput,
) {
  return postJSON<CampaignMaterializeResult>(
    `/engagement/campaigns/${campaignId}/materialize`,
    input,
  );
}

export function submitCampaignForApproval(campaignId: number, reason?: string) {
  return postJSON<EngagementCampaign>(
    `/engagement/campaigns/${campaignId}/submit-approval`,
    { reason: reason || null },
  );
}

export function approveCampaign(campaignId: number, reason?: string) {
  return postJSON<EngagementCampaign>(
    `/engagement/campaigns/${campaignId}/approve`,
    { reason: reason || null },
  );
}

export function queueDueCampaignRecipients(campaignId: number, limit?: number) {
  return postJSON<QueueDueResult>(
    `/engagement/campaigns/${campaignId}/queue-due`,
    { limit: limit ?? 50 },
  );
}
