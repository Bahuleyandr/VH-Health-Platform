import {
  APIError,
  getJSONEnvelope,
  postJSONEnvelope,
  type APIResponse,
} from "./core";

const BASE_PATH = "/api/v1/admin/devices/continuity-facility-context";

export const CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE =
  "CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE";

export type ContinuityFacilityGrantPurpose =
  | "capture_fixed_device"
  | "capture_staff_facility";

export interface ContinuityFacilityGrant {
  id: string;
  facility_id: number;
  grant_purpose: ContinuityFacilityGrantPurpose;
  subject_kind: "device" | "staff_device";
  staff_uid: string | null;
  device_id: string;
  device_credential_sha256: string;
  valid_from: string;
  valid_until: string;
  policy_version_id: string;
  policy_version: string;
  capture_revision: string;
  created_by: string;
  created_at: string;
  revocation_id: string | null;
  revocation_revision: string | null;
  revoked_at: string | null;
  reason: string | null;
}

export interface ContinuityFacilityRevocation {
  id: string;
  grant_id: string;
  grant_purpose: ContinuityFacilityGrantPurpose;
  capture_revision: string;
  revoked_by: string;
  revoked_at: string;
  reason: string;
}

export interface EnrollContinuityFacilityGrantBody {
  facility_id: number;
  grant_purpose: ContinuityFacilityGrantPurpose;
  staff_uid?: string;
  device_id: string;
  device_public_key_base64: string;
  valid_from: string;
  valid_until: string;
}

export interface RevokeContinuityFacilityGrantBody {
  facility_id: number;
  grant_id: string;
  reason: string;
}

export interface ContinuityFacilitySuccessEnvelope<T> {
  success: true;
  message?: string;
  data: T;
  requestId?: string;
}

export type ContinuityFacilityFailureState =
  | "not_activated"
  | "denied"
  | "service_unavailable";

export interface ContinuityFacilityFailure {
  state: ContinuityFacilityFailureState;
  status?: number;
  code?: string;
  message: string;
  requestId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSuccessEnvelope<T>(
  envelope: APIResponse<T>,
): ContinuityFacilitySuccessEnvelope<T> {
  if (envelope.success !== true || envelope.data === undefined) {
    throw new APIError("Malformed facility-context response", 502, envelope);
  }
  return envelope as ContinuityFacilitySuccessEnvelope<T>;
}

export async function listContinuityFacilityGrants(
  facilityId?: number,
): Promise<
  ContinuityFacilitySuccessEnvelope<{ grants: ContinuityFacilityGrant[] }>
> {
  const envelope = await getJSONEnvelope<{
    grants: ContinuityFacilityGrant[];
  }>(`${BASE_PATH}/grants`, { facility_id: facilityId });
  return requireSuccessEnvelope(envelope);
}

export async function enrollContinuityFacilityGrant(
  body: EnrollContinuityFacilityGrantBody,
): Promise<
  ContinuityFacilitySuccessEnvelope<{ grant: ContinuityFacilityGrant }>
> {
  const envelope = await postJSONEnvelope<{
    grant: ContinuityFacilityGrant;
  }>(`${BASE_PATH}/enroll`, body);
  return requireSuccessEnvelope(envelope);
}

export async function revokeContinuityFacilityGrant(
  body: RevokeContinuityFacilityGrantBody,
): Promise<
  ContinuityFacilitySuccessEnvelope<{
    revocation: ContinuityFacilityRevocation;
  }>
> {
  const envelope = await postJSONEnvelope<{
    revocation: ContinuityFacilityRevocation;
  }>(`${BASE_PATH}/revoke`, body);
  return requireSuccessEnvelope(envelope);
}

export function classifyContinuityFacilityError(
  error: unknown,
): ContinuityFacilityFailure {
  const status = error instanceof APIError ? error.status : undefined;
  const payload =
    error instanceof APIError && isRecord(error.data) ? error.data : null;
  const code = typeof payload?.code === "string" ? payload.code : undefined;
  const requestId =
    typeof payload?.requestId === "string" ? payload.requestId : undefined;
  const serverMessage =
    typeof payload?.message === "string" ? payload.message : undefined;

  if (status === 503 && code === CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE) {
    return {
      state: "not_activated",
      status,
      code,
      requestId,
      message:
        serverMessage ??
        "Clinical continuity facility enrollment is unavailable",
    };
  }

  if (status === 403) {
    return {
      state: "denied",
      status,
      code,
      requestId,
      message: serverMessage ?? "Facility-context access was denied",
    };
  }

  return {
    state: "service_unavailable",
    status,
    code,
    requestId,
    message:
      serverMessage ??
      (error instanceof Error
        ? error.message
        : "The facility-context service could not be reached"),
  };
}
