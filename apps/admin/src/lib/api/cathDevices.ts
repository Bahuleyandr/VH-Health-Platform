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
//   * `/api/v1/cath-reprocessing/*` — the governance settings, the per-
//     category policy, and (a later tenant, same audience) the pre-cath lab
//     readiness policy. The first four operations used to sit on the admin
//     cath-consumables barrel behind ADMIN_ROUTE_ROLES, which could never admit
//     the QUALITY_OFFICER / INFECTION_CONTROL_OFFICER the route-level gate
//     named; they now have their own mount and their own audience
//     (CATH_REPROCESSING_POLICY_ROUTE_ROLES).
//
// Both families are reached through core.ts rather than `fetchAdminAPI`,
// because every write here is mounted with
// `requireIdempotencyKey({ required: true })` and `fetchAdminAPI` carries no
// way to attach the header. Scopes: `cssd_device_transition` for the five
// device transitions, `cath_reprocessing_policy` for all three governance PUTs
// (reprocessing settings, category policies, lab readiness settings).
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
/**
 * The pre-cath lab checklist policy. It is NOT device reuse, but it is the
 * same governance audience deciding the same kind of question, so the backend
 * hung it off this mount rather than the platform-admin cath-consumables
 * barrel — whose ADMIN_ROUTE_ROLES can never admit the quality / infection
 * control officers who own it.
 */
export const CATH_LAB_READINESS_SETTINGS_PATH =
  "/api/v1/cath-reprocessing/lab-readiness-settings" as const;

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

export type CathLabReadinessSettings = ApiData<
  typeof CATH_LAB_READINESS_SETTINGS_PATH,
  "get"
>["settings"];
export type CathLabReadinessSettingsInput = ApiBody<
  typeof CATH_LAB_READINESS_SETTINGS_PATH,
  "put"
>;
export type CathLabReadinessItem =
  CathLabReadinessSettings["required_items"][number];

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
 * Mirror of `LAB_ANALYTE_ITEM_CODES` in
 * `apps/backend/src/services/lab/labAnalyteCodes.js`, in the order the
 * checklist reads. The backend refuses a code outside this set
 * (`CATH_LAB_READINESS_ITEM_UNKNOWN`) and refuses an empty set outright
 * (`CATH_LAB_READINESS_ITEMS_EMPTY`).
 */
export const CATH_LAB_READINESS_ITEMS = [
  "hb",
  "platelets",
  "creatinine",
  "potassium",
  "hiv",
  "hbsag",
  "hcv",
] as const satisfies readonly CathLabReadinessItem[];

/**
 * Display names. The wire values are analyte codes, not words: `humanize`
 * would render "hb" and "hbsag" verbatim, which is neither how a lab report
 * reads nor how a screen reader should announce the checkbox.
 */
export const CATH_LAB_READINESS_ITEM_LABELS: Readonly<
  Record<CathLabReadinessItem, string>
> = {
  hb: "Haemoglobin",
  platelets: "Platelets",
  creatinine: "Creatinine",
  potassium: "Potassium",
  hiv: "HIV",
  hbsag: "HBsAg",
  hcv: "HCV",
};

/**
 * Mirror of `BLOODBORNE_MARKER_ITEM_CODES` (the items whose analyte carries a
 * `marker`). Their freshness is judged against the REUSE programme's
 * `serology_validity_days`, not `lab_validity_days` — one tenant number for
 * "how long is an HIV/HBsAg/HCV result good for", set on the Reprocessing
 * policy tab and read here so the editor does not imply a second window.
 */
export const CATH_LAB_READINESS_SEROLOGY_ITEMS: ReadonlySet<CathLabReadinessItem> =
  new Set<CathLabReadinessItem>(["hiv", "hbsag", "hcv"]);

/**
 * Mirror of IMPLANT_CATEGORIES in
 * `apps/backend/src/services/clinical/cathDeviceReuseService.js`. Marking one
 * of these reprocessable is a hard 400
 * (`CATH_REPROCESSING_IMPLANT_FORBIDDEN`), so the editor disables the toggle
 * rather than offering a control that can only ever fail.
 */
export const IMPLANT_CATEGORIES: ReadonlySet<CathCategory> =
  new Set<CathCategory>(["stent", "pacemaker", "lead", "closure_device"]);

/**
 * Display names for `exposure_markers` — the blood-borne markers a PREVIOUS
 * patient tested reactive for. The wire values are the backend's lowercase
 * enum (`hiv | hbsag | hcv | cjd_suspected | other`) and the generic
 * `humanize` would render them as "hbsag" and "cjd suspected", which is not
 * how the labels read on a serology report or in a screen reader. Anything the
 * enum grows falls back to the underscore-stripped value rather than vanishing.
 */
export const EXPOSURE_MARKER_LABELS: Readonly<Record<string, string>> = {
  hiv: "HIV",
  hbsag: "HBsAg",
  hcv: "HCV",
  cjd_suspected: "CJD suspected",
  other: "Other",
};

export function exposureMarkerLabel(marker: string): string {
  return EXPOSURE_MARKER_LABELS[marker] ?? marker.replace(/_/g, " ");
}

/** GET /cssd/devices caps `limit` at 500; the console asks for a page of 200. */
export const CSSD_DEVICE_LIST_LIMIT = 200;

/**
 * TanStack Query key for the category policy list, shared by the two screens
 * that read it: the quality console's Reprocessing policy tab (which owns the
 * editor) and the CSSD Devices tab (which offers a cycle-type picker built
 * from it). One key means a policy saved on the first screen is what the
 * second offers, from one cache entry — two keys would be two fetches and, for
 * as long as one of them was stale, two different answers to "what may CSSD
 * record for a catheter".
 */
export const CATH_REPROCESSING_POLICIES_QUERY_KEY = [
  "cath",
  "reprocessing",
  "policies",
] as const;

/**
 * The cycle types CSSD may record for a device of `category`. Mirrors
 * `markDeviceReprocessed` in
 * `apps/backend/src/services/clinical/cathDeviceReuseService.js`:
 *
 *   * no policy row for the category, or `reprocessable !== true`
 *     → 409 `CATH_REPROCESSING_NOT_ALLOWED`, whatever type is sent;
 *   * a type outside `allowed_cycle_types`
 *     → 409 `CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED`, carrying the allowed list.
 *
 * So an EMPTY return means "every cycle type would be refused", which is what
 * the Devices tab disables the Reprocess action on. The result is ordered by
 * the published vocabulary rather than by the stored array, so the picker
 * reads the same however the policy happened to be saved, and a value the
 * tenant stored that is not in the vocabulary is dropped rather than offered.
 */
export function allowedCycleTypesForCategory(
  policies: readonly CathReprocessingPolicy[] | null | undefined,
  category: CathCategory,
): CathDeviceCycleType[] {
  const policy = policies?.find((entry) => entry.category === category);
  if (!policy || policy.reprocessable !== true) return [];
  const allowed = new Set<string>(policy.allowed_cycle_types);
  return CATH_DEVICE_CYCLE_TYPES.filter((type) => allowed.has(type));
}

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

export function getCathLabReadinessSettings() {
  return getJSON<{ settings: CathLabReadinessSettings }>(
    CATH_LAB_READINESS_SETTINGS_PATH,
  );
}

/**
 * A WHOLE-policy replacement, not a patch: `upsertReadinessSettings` writes an
 * omitted field back at its compiled-in default (all seven items, 30 days,
 * auto-pass on, outside results count). So the editor always sends all four,
 * or a tenant that only meant to shorten the window would silently re-require
 * the items it had switched off. The key carries the same
 * `cath_reprocessing_policy` scope as the two sibling PUTs on this mount.
 */
export function updateCathLabReadinessSettings(
  body: CathLabReadinessSettingsInput,
  idempotencyKey: string,
) {
  return putJSON<{ settings: CathLabReadinessSettings }>(
    CATH_LAB_READINESS_SETTINGS_PATH,
    body,
    true,
    transitionHeaders(idempotencyKey),
  );
}
