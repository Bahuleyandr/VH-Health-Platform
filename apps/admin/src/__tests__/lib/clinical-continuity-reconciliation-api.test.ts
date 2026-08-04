import {
  bindClinicalContinuityHeldMessage,
  loadClinicalContinuityWorkbench,
  releaseClinicalContinuityHeldMessage,
  transitionClinicalContinuityIncident,
} from "@/lib/api/clinicalContinuityReconciliation";
import { fetchAdminAPI } from "@/lib/api/core";

jest.mock("@/lib/api/core", () => ({
  fetchAdminAPI: jest.fn(),
}));

const mockedFetch = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;
const authority = { facilityId: 17, facilityContext: "signed-envelope" };

describe("clinical continuity reconciliation API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetch.mockResolvedValue({} as never);
  });

  it("loads the typed workbench with both server-issued facility headers", async () => {
    await loadClinicalContinuityWorkbench(authority);

    expect(mockedFetch).toHaveBeenCalledWith(
      "/downtime/reconciliation/workbench",
      {
        headers: {
          "X-VH-Continuity-Facility-Id": "17",
          "X-VH-Continuity-Facility-Context": "signed-envelope",
        },
      },
    );
  });

  it("sends CAS state transitions without client-supplied role or tenant authority", async () => {
    await transitionClinicalContinuityIncident(
      authority,
      "11111111-1111-4111-8111-111111111111",
      { expected_version: 4, next_state: "reconciling" },
    );

    const [path, options] = mockedFetch.mock.calls[0];
    expect(path).toBe(
      "/downtime/reconciliation/incidents/11111111-1111-4111-8111-111111111111/state",
    );
    expect(options).toEqual({
      method: "PATCH",
      body: { expected_version: 4, next_state: "reconciling" },
      headers: expect.objectContaining({
        "X-VH-Continuity-Facility-Id": "17",
        "X-VH-Continuity-Facility-Context": "signed-envelope",
      }),
    });
    expect(JSON.stringify(options)).not.toMatch(/tenant|actor|role/i);
  });

  it("binds one exact releaseable message without a bulk predicate", async () => {
    await bindClinicalContinuityHeldMessage(authority, "incident-1", {
      incident_interface_id: "11111111-1111-4111-8111-111111111111",
      interface_family: "I05",
      message_id: 47,
      expected_incident_interface_version: 3,
      expected_source_state_fingerprint: "a".repeat(64),
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      "/downtime/reconciliation/incidents/incident-1/interface-held-messages",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({ interface_family: "I05", message_id: 47 }),
      }),
    );
    expect(JSON.stringify(mockedFetch.mock.calls[0])).not.toMatch(/predicate|I18/);
  });

  it("requires and forwards the release Idempotency-Key", async () => {
    await releaseClinicalContinuityHeldMessage(
      authority,
      "item-1",
      "held-release-47",
      {
        expected_version: 4,
        release_reason_code: "downstream_readiness_confirmed",
        release_reason_detail: "Downstream evidence was reviewed.",
        expected_source_state_fingerprint: "b".repeat(64),
        safety_attestation_id: "22222222-2222-4222-8222-222222222222",
      },
    );

    expect(mockedFetch).toHaveBeenCalledWith(
      "/downtime/reconciliation/reconciliation-items/item-1/held-message-release",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Idempotency-Key": "held-release-47" }),
      }),
    );
  });

  it("rejects malformed authority before a request can leave the browser", () => {
    expect(() =>
      loadClinicalContinuityWorkbench({ facilityId: 0, facilityContext: "x" }),
    ).toThrow("positive facility ID");
    expect(() =>
      loadClinicalContinuityWorkbench({
        facilityId: 17,
        facilityContext: "not signed!",
      }),
    ).toThrow("server-issued facility context");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("rejects an empty release Idempotency-Key before a request leaves the browser", () => {
    expect(() =>
      releaseClinicalContinuityHeldMessage(authority, "item-1", "  ", {
        expected_version: 1,
        release_reason_code: "owner_recovery_evidence_reconciled",
        release_reason_detail: "Owner evidence was reconciled.",
        expected_source_state_fingerprint: "c".repeat(64),
      }),
    ).toThrow("bounded Idempotency-Key");
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
