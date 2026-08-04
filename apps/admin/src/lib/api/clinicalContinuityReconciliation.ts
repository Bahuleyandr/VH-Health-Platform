import type { components } from "../openapi.generated";
import { fetchAdminAPI } from "./core";

type GeneratedWorkbench = components["schemas"]["ClinicalContinuityWorkbench"];
type GeneratedQueueItem = GeneratedWorkbench["reconciliation_items"][number];
export type ClinicalContinuityHeldMessageFamily = "I04" | "I05" | "I19";
export type ClinicalContinuityHeldMessageReleaseReason =
  | "downstream_readiness_confirmed"
  | "transport_configuration_corrected"
  | "duplicate_delivery_risk_reviewed"
  | "acknowledgement_uncertainty_reviewed"
  | "owner_recovery_evidence_reconciled";
export type ClinicalContinuityHeldMessageQueueItem = GeneratedQueueItem & {
  interface_item_kind: "held_message_release";
  interface_family: ClinicalContinuityHeldMessageFamily;
  hl7_outbound_message_id?: number | null;
  interop_message_id?: number | null;
  nhcx_message_id?: number | string | null;
  hold_safety_class: "routine_operational" | "safety_critical" | "unclassified";
  source_state_fingerprint: string;
  source_safe_evidence: Record<string, unknown>;
  release_attestation_id?: string | null;
  release_receipt_disposition?: string | null;
  release_receipt_outcome_code?: string | null;
  can_attest_release: boolean;
  can_release: boolean;
};
export type ClinicalContinuityWorkbench = Omit<
  GeneratedWorkbench,
  "reconciliation_items" | "capabilities"
> & {
  reconciliation_items: Array<
    GeneratedQueueItem | ClinicalContinuityHeldMessageQueueItem
  >;
  capabilities?: { can_bind: boolean };
};
export type ClinicalContinuityIncident =
  components["schemas"]["ClinicalContinuityIncident"];
export type ClinicalContinuityClosure =
  components["schemas"]["ClinicalContinuityClosure"];
export type ClinicalContinuityRangeDispositionRequest =
  components["schemas"]["ClinicalContinuityRangeDispositionRequest"];
export type ClinicalContinuityIncidentTransitionRequest =
  components["schemas"]["ClinicalContinuityIncidentTransitionRequest"];
export type ClinicalContinuityInterfaceRequirementRequest =
  components["schemas"]["ClinicalContinuityInterfaceRequirementRequest"];
export type ClinicalContinuityDeviceOffsetRequest =
  components["schemas"]["ClinicalContinuityDeviceOffsetRequest"];
export type ClinicalContinuityIdentityMatchRequest =
  components["schemas"]["ClinicalContinuityIdentityMatchRequest"];
export type ClinicalContinuityAttestationRequest =
  components["schemas"]["ClinicalContinuityAttestationRequest"];
export type ClinicalContinuityDecisionRequest =
  components["schemas"]["ClinicalContinuityDecisionRequest"];

export interface ClinicalContinuityHeldMessageBindRequest {
  incident_interface_id: string;
  interface_family: ClinicalContinuityHeldMessageFamily;
  message_id: number;
  expected_incident_interface_version: number;
  expected_source_state_fingerprint: string;
}

export interface ClinicalContinuityHeldMessageReleaseRequest {
  expected_version: number;
  release_reason_code: ClinicalContinuityHeldMessageReleaseReason;
  release_reason_detail: string;
  expected_source_state_fingerprint: string;
  safety_attestation_id?: string | null;
}

export interface ClinicalContinuityFacilityAuthority {
  facilityId: number;
  facilityContext: string;
}

type AdminCommandResult =
  components["schemas"]["ClinicalContinuityAdminCommandResult"];

function authorityHeaders(
  authority: ClinicalContinuityFacilityAuthority,
): HeadersInit {
  if (!Number.isSafeInteger(authority.facilityId) || authority.facilityId < 1) {
    throw new TypeError("A positive facility ID is required");
  }
  const context = authority.facilityContext.trim();
  if (!context || !/^[A-Za-z0-9_-]+$/.test(context)) {
    throw new TypeError("A server-issued facility context is required");
  }
  return {
    "X-VH-Continuity-Facility-Id": String(authority.facilityId),
    "X-VH-Continuity-Facility-Context": context,
  };
}

function command<T = AdminCommandResult>(
  path: string,
  authority: ClinicalContinuityFacilityAuthority,
  method: "POST" | "PUT" | "PATCH",
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  return fetchAdminAPI<T>(path, {
    method,
    body,
    headers: { ...authorityHeaders(authority), ...headers },
  });
}

export function bindClinicalContinuityHeldMessage(
  authority: ClinicalContinuityFacilityAuthority,
  incidentId: string,
  request: ClinicalContinuityHeldMessageBindRequest,
) {
  return command(
    `/downtime/reconciliation/incidents/${encodeURIComponent(incidentId)}/interface-held-messages`,
    authority,
    "POST",
    request,
  );
}

export function attestClinicalContinuityHeldMessageRelease(
  authority: ClinicalContinuityFacilityAuthority,
  itemId: string,
  request: Omit<
    ClinicalContinuityHeldMessageReleaseRequest,
    "safety_attestation_id"
  >,
) {
  return command(
    `/downtime/reconciliation/reconciliation-items/${encodeURIComponent(itemId)}/held-message-release/attestations`,
    authority,
    "POST",
    request,
  );
}

export function releaseClinicalContinuityHeldMessage(
  authority: ClinicalContinuityFacilityAuthority,
  itemId: string,
  idempotencyKey: string,
  request: ClinicalContinuityHeldMessageReleaseRequest,
) {
  const key = idempotencyKey.trim();
  if (!key || key.length > 200) {
    throw new TypeError("A bounded Idempotency-Key is required");
  }
  return command(
    `/downtime/reconciliation/reconciliation-items/${encodeURIComponent(itemId)}/held-message-release`,
    authority,
    "POST",
    request,
    { "Idempotency-Key": key },
  );
}

export function loadClinicalContinuityWorkbench(
  authority: ClinicalContinuityFacilityAuthority,
): Promise<ClinicalContinuityWorkbench> {
  return fetchAdminAPI<ClinicalContinuityWorkbench>(
    "/downtime/reconciliation/workbench",
    { headers: authorityHeaders(authority) },
  );
}

export function transitionClinicalContinuityIncident(
  authority: ClinicalContinuityFacilityAuthority,
  incidentId: string,
  request: ClinicalContinuityIncidentTransitionRequest,
) {
  return command(
    `/downtime/reconciliation/incidents/${encodeURIComponent(incidentId)}/state`,
    authority,
    "PATCH",
    request,
  );
}

export function recordClinicalContinuityRangeDisposition(
  authority: ClinicalContinuityFacilityAuthority,
  incidentId: string,
  request: ClinicalContinuityRangeDispositionRequest,
) {
  return command(
    `/downtime/reconciliation/incidents/${encodeURIComponent(incidentId)}/range-disposition`,
    authority,
    "POST",
    request,
  );
}

export function recordClinicalContinuityInterfaceRequirement(
  authority: ClinicalContinuityFacilityAuthority,
  incidentId: string,
  request: ClinicalContinuityInterfaceRequirementRequest,
) {
  return command(
    `/downtime/reconciliation/incidents/${encodeURIComponent(incidentId)}/interfaces/requirement`,
    authority,
    "PUT",
    request,
  );
}

export function recordClinicalContinuityDeviceOffset(
  authority: ClinicalContinuityFacilityAuthority,
  incidentId: string,
  deviceId: string,
  request: ClinicalContinuityDeviceOffsetRequest,
) {
  return command(
    `/downtime/reconciliation/incidents/${encodeURIComponent(incidentId)}/devices/${encodeURIComponent(deviceId)}/offset`,
    authority,
    "PUT",
    request,
  );
}

export function proposeClinicalContinuityIdentityMatch(
  authority: ClinicalContinuityFacilityAuthority,
  incidentId: string,
  request: ClinicalContinuityIdentityMatchRequest,
) {
  return command(
    `/downtime/reconciliation/incidents/${encodeURIComponent(incidentId)}/identity-matches`,
    authority,
    "POST",
    request,
  );
}

export function approveClinicalContinuityIdentityMatch(
  authority: ClinicalContinuityFacilityAuthority,
  mergeId: number,
  note?: string,
) {
  return command(
    `/downtime/reconciliation/identity-matches/${mergeId}/approve`,
    authority,
    "POST",
    { note: note?.trim() || null },
  );
}

export function executeClinicalContinuityIdentityMatch(
  authority: ClinicalContinuityFacilityAuthority,
  mergeId: number,
) {
  return command(
    `/downtime/reconciliation/identity-matches/${mergeId}/execute`,
    authority,
    "POST",
  );
}

export function decideClinicalContinuityReconciliationItem(
  authority: ClinicalContinuityFacilityAuthority,
  itemId: string,
  request: ClinicalContinuityDecisionRequest,
) {
  return command(
    `/downtime/reconciliation/reconciliation-items/${encodeURIComponent(itemId)}/decision`,
    authority,
    "POST",
    request,
  );
}

export function checkClinicalContinuityClosure(
  authority: ClinicalContinuityFacilityAuthority,
  incidentId: string,
): Promise<ClinicalContinuityClosure> {
  return fetchAdminAPI<ClinicalContinuityClosure>(
    `/downtime/reconciliation/incidents/${encodeURIComponent(incidentId)}/closure`,
    { headers: authorityHeaders(authority) },
  );
}

export function attestClinicalContinuityClosure(
  authority: ClinicalContinuityFacilityAuthority,
  incidentId: string,
  request: ClinicalContinuityAttestationRequest,
) {
  return command(
    `/downtime/reconciliation/incidents/${encodeURIComponent(incidentId)}/closure/attestations`,
    authority,
    "POST",
    request,
  );
}

export function closeClinicalContinuityIncident(
  authority: ClinicalContinuityFacilityAuthority,
  incidentId: string,
  expectedVersion: number,
) {
  return command(
    `/downtime/reconciliation/incidents/${encodeURIComponent(incidentId)}/closure/close`,
    authority,
    "POST",
    { expected_version: expectedVersion },
  );
}
