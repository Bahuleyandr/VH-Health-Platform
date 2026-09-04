// Cath reprocessable devices (the CSSD queue) and the reprocessing policy that
// governs them.
//
// TWO BACKEND MOUNTS, deliberately different audiences:
//
//   * `/api/v1/cssd/devices/*` — the physical queue. cssdRoutes.js narrows the
//     whole `/devices` sub-tree to CSSD_DEVICE_ROUTE_ROLES (sterile processing,
//     the wards, infection control, quality, platform admin) because a discard
//     is irreversible and the wider /cssd mount carries audit and supply-chain
//     roles that never touch a device.
//   * `/api/v1/cath-reprocessing/*` — the governance settings and the per-
//     category policy. These four operations used to sit on the admin
//     cath-consumables barrel behind ADMIN_ROUTE_ROLES, which could never admit
//     the QUALITY_OFFICER / INFECTION_CONTROL_OFFICER the route-level gate
//     named; they now have their own mount and their own audience
//     (CATH_REPROCESSING_POLICY_ROUTE_ROLES).
//
// Both families are reached through core.ts rather than `fetchAdminAPI`,
// because every write here is mounted with
// `requireIdempotencyKey({ required: true })` and `fetchAdminAPI` carries no
// way to attach the header. Scopes: `cssd_device_transition` for the five
// device transitions, `cath_reprocessing_policy` for both policy PUTs.
//
// The key is a REQUIRED parameter on every mutation, exactly as in
// `cathConsumables.upsertCathConsumable`. It is minted and reset by the React
// layer (`useIdempotencyKey` + `payloadIdentity`). A module-level attempt store
// would be tempting and wrong: it is never reset by anyone, so a deliberate
// second action that happens to produce the same payload identity — receive,
// quarantine, release, quarantine again — would reuse the first attempt's key
// and the backend would replay its recorded response instead of writing. A
// fresh `crypto.randomUUID()` per click is the opposite failure: a double-click
// then runs the transition twice, which is what the header exists to prevent.
//
// GET /api/v1/cath-reprocessing/devices/{deviceId}/history is deliberately not
// wired here. It is the one PHI read on that mount (it writes a
// hipaa_access_log row per patient in the answer) and no admin surface asks for
// a device's patient history yet; adding a caller would open a patient-data
// view nobody reviewed.

import type { ApiBody, ApiData } from "@/lib/openapi-data";

import { assertIdempotencyKey } from "../idempotencyKey";

import { getJSON, postJSON, putJSON } from "./core";

export const CSSD_DEVICES_PATH = "/api/v1/cssd/devices" as const;
export const CATH_REPROCESSING_SETTINGS_PATH =
  "/api/v1/cath-reprocessing/settings" as const;
export const CATH_REPROCESSING_POLICIES_PATH =
  "/api/v1/cath-reprocessing/policies" as const;

/** One row of GET /api/v1/cssd/devices — the spec's CathReprocessableDevice. */
export type CathDevice = ApiData<typeof CSSD_DEVICES_PATH, "get">[number];
export type CathDeviceStatus = CathDevice["status"];
export type CathDeviceCycleType = NonNullable<CathDevice["last_cycle_type"]>;
export type CathDeviceFunctionCheck = NonNullable<
  CathDevice["last_function_check"]
>;
export type CathDeviceDiscardReason = NonNullable<CathDevice["discard_reason"]>;
export type CathCategory = CathDevice["category"];

export type CathDeviceReprocessedInput = ApiBody<
  "/api/v1/cssd/devices/{id}/reprocessed",
  "post"
>;
export type CathDeviceQuarantineInput = ApiBody<
  "/api/v1/cssd/devices/{id}/quarantine",
  "post"
>;
export type CathDeviceReleaseInput = ApiBody<
  "/api/v1/cssd/devices/{id}/release",
  "post"
>;
export type CathDeviceDiscardInput = ApiBody<
  "/api/v1/cssd/devices/{id}/discard",
  "post"
>;

export type CathReprocessingSettings = ApiData<
  typeof CATH_REPROCESSING_SETTINGS_PATH,
  "get"
>["settings"];
export type CathReprocessingSettingsInput = ApiBody<
  typeof CATH_REPROCESSING_SETTINGS_PATH,
  "put"
>;
export type CathReprocessingPoliciesResult = ApiData<
  typeof CATH_REPROCESSING_POLICIES_PATH,
  "get"
>;
export type CathReprocessingPolicy =
  CathReprocessingPoliciesResult["policies"][number];
export type CathReprocessingPolicyInput = ApiBody<
  typeof CATH_REPROCESSING_POLICIES_PATH,
  "put"
>["policies"][number];

/**
 * Runtime mirrors of the spec enums. `satisfies` pins each list to the
 * generated type, so a backend enum change fails type-check here instead of
 * silently leaving a dead option in a dropdown.
 */
export const CSSD_DEVICE_STATUSES = [
  "awaiting_reprocessing",
  "in_cssd",
  "available",
  "in_case",
  "quarantined",
  "discarded",
] as const satisfies readonly CathDeviceStatus[];

export const CATH_DEVICE_CYCLE_TYPES = [
  "steam",
  "eto",
  "plasma",
  "dry_heat",
  "chemical",
  "other",
] as const satisfies readonly CathDeviceCycleType[];

export const CATH_DEVICE_DISCARD_REASONS = [
  "max_cycles_reached",
  "bloodborne_exposure",
  "late_reactive_marker",
  "function_check_failed",
  "sterilization_failed",
  "damaged",
  "wasted",
  "policy_change",
  "other",
] as const satisfies readonly CathDeviceDiscardReason[];

export const CATH_CATEGORIES = [
  "stent",
  "balloon",
  "guidewire",
  "catheter",
  "sheath",
  "closure_device",
  "pacemaker",
  "lead",
  "other",
] as const satisfies readonly CathCategory[];

/**
 * Mirror of IMPLANT_CATEGORIES in
 * `apps/backend/src/services/clinical/cathDeviceReuseService.js`. Marking one
 * of these reprocessable is a hard 400
 * (`CATH_REPROCESSING_IMPLANT_FORBIDDEN`), so the editor disables the toggle
 * rather than offering a control that can only ever fail.
 */
export const IMPLANT_CATEGORIES: ReadonlySet<CathCategory> =
  new Set<CathCategory>(["stent", "pacemaker", "lead", "closure_device"]);

/** GET /cssd/devices caps `limit` at 500; the console asks for a page of 200. */
export const CSSD_DEVICE_LIST_LIMIT = 200;

function transitionHeaders(idempotencyKey: string) {
  return { "Idempotency-Key": assertIdempotencyKey(idempotencyKey) };
}

export function listCssdDevices(
  params: {
    status?: CathDeviceStatus;
    facility_id?: number;
    limit?: number;
  } = {},
) {
  return getJSON<CathDevice[]>(CSSD_DEVICES_PATH, {
    status: params.status,
    facility_id: params.facility_id,
    limit: params.limit ?? CSSD_DEVICE_LIST_LIMIT,
  });
}

export function receiveCssdDevice(id: number, idempotencyKey: string) {
  // No request body in the spec; the route reads `req.params.id` alone.
  return postJSON<CathDevice>(
    `/api/v1/cssd/devices/${id}/receive`,
    {},
    true,
    transitionHeaders(idempotencyKey),
  );
}

export function markCssdDeviceReprocessed(
  id: number,
  body: CathDeviceReprocessedInput,
  idempotencyKey: string,
) {
  return postJSON<CathDevice>(
    `/api/v1/cssd/devices/${id}/reprocessed`,
    body,
    true,
    transitionHeaders(idempotencyKey),
  );
}

export function quarantineCssdDevice(
  id: number,
  body: CathDeviceQuarantineInput,
  idempotencyKey: string,
) {
  return postJSON<CathDevice>(
    `/api/v1/cssd/devices/${id}/quarantine`,
    body,
    true,
    transitionHeaders(idempotencyKey),
  );
}

export function releaseCssdDevice(
  id: number,
  body: CathDeviceReleaseInput,
  idempotencyKey: string,
) {
  return postJSON<CathDevice>(
    `/api/v1/cssd/devices/${id}/release`,
    body,
    true,
    transitionHeaders(idempotencyKey),
  );
}

export function discardCssdDevice(
  id: number,
  body: CathDeviceDiscardInput,
  idempotencyKey: string,
) {
  return postJSON<CathDevice>(
    `/api/v1/cssd/devices/${id}/discard`,
    body,
    true,
    transitionHeaders(idempotencyKey),
  );
}

export function getCathReprocessingSettings() {
  return getJSON<{ settings: CathReprocessingSettings }>(
    CATH_REPROCESSING_SETTINGS_PATH,
  );
}

export function updateCathReprocessingSettings(
  body: CathReprocessingSettingsInput,
  idempotencyKey: string,
) {
  return putJSON<{ settings: CathReprocessingSettings }>(
    CATH_REPROCESSING_SETTINGS_PATH,
    body,
    true,
    transitionHeaders(idempotencyKey),
  );
}

export function listCathReprocessingPolicies() {
  return getJSON<CathReprocessingPoliciesResult>(
    CATH_REPROCESSING_POLICIES_PATH,
  );
}

/**
 * PUT the WHOLE category set, not a delta. `upsertCategoryPolicies` refuses a
 * duplicated category and refuses more entries than there are categories, but
 * it does not delete rows the caller omits — so an omitted category would keep
 * whatever it held while the editor claimed to have saved the screen.
 */
export function updateCathReprocessingPolicies(
  policies: CathReprocessingPolicyInput[],
  idempotencyKey: string,
) {
  return putJSON<CathReprocessingPoliciesResult>(
    CATH_REPROCESSING_POLICIES_PATH,
    { policies },
    true,
    transitionHeaders(idempotencyKey),
  );
}
