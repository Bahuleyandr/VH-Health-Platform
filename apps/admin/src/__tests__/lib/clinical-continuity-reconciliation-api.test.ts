import {
  loadClinicalContinuityWorkbench,
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
});
