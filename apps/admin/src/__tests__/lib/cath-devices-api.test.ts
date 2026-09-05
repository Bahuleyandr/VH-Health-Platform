// Contract pins for the cath device-reuse client.
//
// Every mutation in this module is mounted with
// `requireIdempotencyKey({ required: true })` on the backend, so a call that
// loses the header is a hard 400 rather than a degraded save — and the 401→
// refresh replay in `api/core.ts` refuses to re-send an unsafe method without
// one. These tests assert the exact path, body and header of each call, so a
// silently dropped header fails here instead of in a hospital.

import {
  CATH_LAB_READINESS_ITEMS,
  CATH_LAB_READINESS_SETTINGS_PATH,
  CATH_REPROCESSING_POLICIES_PATH,
  CATH_REPROCESSING_SETTINGS_PATH,
  CSSD_DEVICES_PATH,
  discardCssdDevice,
  getCathLabReadinessSettings,
  getCathReprocessingSettings,
  listCathReprocessingPolicies,
  listCssdDevices,
  markCssdDeviceReprocessed,
  quarantineCssdDevice,
  receiveCssdDevice,
  releaseCssdDevice,
  updateCathLabReadinessSettings,
  updateCathReprocessingPolicies,
  updateCathReprocessingSettings,
} from "@/lib/api/cathDevices";
import { getJSON, postJSON, putJSON } from "@/lib/api/core";

jest.mock("@/lib/api/core", () => ({
  getJSON: jest.fn(),
  postJSON: jest.fn(),
  putJSON: jest.fn(),
}));

const mockedGetJSON = getJSON as jest.MockedFunction<typeof getJSON>;
const mockedPostJSON = postJSON as jest.MockedFunction<typeof postJSON>;
const mockedPutJSON = putJSON as jest.MockedFunction<typeof putJSON>;

const KEY = "cssd-device-transition:11111111-2222-3333-4444-555555555555";
const POLICY_KEY = "cath-reprocessing-policy:aaaa-bbbb";

describe("cath device-reuse admin API client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetJSON.mockResolvedValue({} as never);
    mockedPostJSON.mockResolvedValue({} as never);
    mockedPutJSON.mockResolvedValue({} as never);
  });

  it("reads the CSSD device queue with the filters the route accepts", async () => {
    await listCssdDevices({ status: "quarantined", facility_id: 7, limit: 50 });
    expect(mockedGetJSON).toHaveBeenCalledWith(CSSD_DEVICES_PATH, {
      status: "quarantined",
      facility_id: 7,
      limit: 50,
    });

    // Unfiltered read still bounds the page: the route caps `limit` at 500.
    await listCssdDevices();
    expect(mockedGetJSON).toHaveBeenLastCalledWith(CSSD_DEVICES_PATH, {
      status: undefined,
      facility_id: undefined,
      limit: 200,
    });
  });

  it.each([
    ["receive", () => receiveCssdDevice(4, KEY), "/receive", {}],
    [
      "reprocessed",
      () => markCssdDeviceReprocessed(4, { cycle_type: "plasma" }, KEY),
      "/reprocessed",
      { cycle_type: "plasma" },
    ],
    [
      "quarantine",
      () => quarantineCssdDevice(4, { reason: "seal damaged" }, KEY),
      "/quarantine",
      { reason: "seal damaged" },
    ],
    [
      "release",
      () => releaseCssdDevice(4, { note: "cleared" }, KEY),
      "/release",
      { note: "cleared" },
    ],
    [
      "discard",
      () => discardCssdDevice(4, { reason: "damaged" }, KEY),
      "/discard",
      { reason: "damaged" },
    ],
  ])(
    "sends %s with an Idempotency-Key (scope cssd_device_transition)",
    async (_name, call, suffix, body) => {
      await call();
      expect(mockedPostJSON).toHaveBeenCalledWith(
        `/api/v1/cssd/devices/4${suffix}`,
        body,
        true,
        { "Idempotency-Key": KEY },
      );
    },
  );

  it("refuses a malformed transition key before the request leaves the browser", () => {
    // A 400 from the server is indistinguishable from a header that was never
    // sent, so a bad key is a call-site programming error caught locally.
    expect(() => receiveCssdDevice(4, "not a valid key")).toThrow(TypeError);
    expect(mockedPostJSON).not.toHaveBeenCalled();
  });

  it("reads and writes reprocessing settings on the governance mount", async () => {
    await getCathReprocessingSettings();
    expect(mockedGetJSON).toHaveBeenCalledWith(CATH_REPROCESSING_SETTINGS_PATH);

    const body = {
      reactive_patient_rule: "discard",
      unknown_serology_rule: "warn",
      serology_validity_days: 90,
    } as const;
    await updateCathReprocessingSettings(body, POLICY_KEY);
    expect(mockedPutJSON).toHaveBeenCalledWith(
      CATH_REPROCESSING_SETTINGS_PATH,
      body,
      true,
      { "Idempotency-Key": POLICY_KEY },
    );
  });

  it("wraps the whole category set in the policies PUT payload", async () => {
    await listCathReprocessingPolicies();
    expect(mockedGetJSON).toHaveBeenCalledWith(CATH_REPROCESSING_POLICIES_PATH);

    const policies = [
      {
        category: "catheter" as const,
        reprocessable: true,
        max_cycles: 3,
        allowed_cycle_types: ["eto" as const],
        function_check_required: true,
      },
    ];
    await updateCathReprocessingPolicies(policies, POLICY_KEY);
    // `policies` is the request body's only field — the service reads
    // req.body?.policies and refuses an empty array.
    expect(mockedPutJSON).toHaveBeenCalledWith(
      CATH_REPROCESSING_POLICIES_PATH,
      { policies },
      true,
      { "Idempotency-Key": POLICY_KEY },
    );
  });

  it("reads and writes lab readiness settings on the same governance mount", async () => {
    await getCathLabReadinessSettings();
    expect(mockedGetJSON).toHaveBeenCalledWith(
      CATH_LAB_READINESS_SETTINGS_PATH,
    );

    // The PUT replaces the policy wholesale — an omitted field is written back
    // at its default — so the body is passed through untouched and callers are
    // expected to send all four.
    const body = {
      required_items: ["hb" as const, "creatinine" as const],
      lab_validity_days: 14,
      auto_pass: false,
      external_results_count: true,
    };
    await updateCathLabReadinessSettings(body, POLICY_KEY);
    expect(mockedPutJSON).toHaveBeenCalledWith(
      CATH_LAB_READINESS_SETTINGS_PATH,
      body,
      true,
      { "Idempotency-Key": POLICY_KEY },
    );
  });

  it("mirrors the backend's seven lab readiness item codes", () => {
    // LAB_ANALYTE_ITEM_CODES in
    // apps/backend/src/services/lab/labAnalyteCodes.js. A code outside the set
    // is a 400 CATH_LAB_READINESS_ITEM_UNKNOWN, so a drifted list is a
    // checkbox that can never be saved.
    expect([...CATH_LAB_READINESS_ITEMS]).toEqual([
      "hb",
      "platelets",
      "creatinine",
      "potassium",
      "hiv",
      "hbsag",
      "hcv",
    ]);
  });

  it("refuses a malformed policy key on all three governance writes", () => {
    expect(() =>
      updateCathReprocessingSettings({ serology_validity_days: 30 }, "bad key"),
    ).toThrow(TypeError);
    expect(() =>
      updateCathReprocessingPolicies(
        [{ category: "balloon", reprocessable: false }],
        "bad key",
      ),
    ).toThrow(TypeError);
    expect(() =>
      updateCathLabReadinessSettings({ lab_validity_days: 30 }, "bad key"),
    ).toThrow(TypeError);
    expect(mockedPutJSON).not.toHaveBeenCalled();
  });
});
