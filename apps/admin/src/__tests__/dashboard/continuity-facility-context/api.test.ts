import { APIError } from "@/lib/api/core";
import { apiFetch } from "@/lib/api-fetch";
import {
  CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE,
  classifyContinuityFacilityError,
  listContinuityFacilityGrants,
} from "@/lib/api/continuityFacilityContext";

jest.mock("@/lib/api-fetch", () => ({ apiFetch: jest.fn() }));

const mockedApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

function jsonResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe("continuity facility-context typed absence", () => {
  beforeEach(() => jest.clearAllMocks());

  it("preserves and classifies the landed 503 response-helper envelope", async () => {
    const envelope = {
      success: false,
      message: "Clinical continuity facility enrollment is unavailable",
      requestId: "req-cd14-503",
      code: CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE,
    };
    mockedApiFetch.mockResolvedValueOnce(jsonResponse(envelope, 503));

    let caught: unknown;
    try {
      await listContinuityFacilityGrants();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(APIError);
    expect(classifyContinuityFacilityError(caught)).toEqual({
      state: "not_activated",
      status: 503,
      code: CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE,
      requestId: "req-cd14-503",
      message: "Clinical continuity facility enrollment is unavailable",
    });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/admin/devices/continuity-facility-context/grants",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("classifies a server denial without exposing grant data", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          message: "Only integration admins can manage devices",
          requestId: "req-cd14-403",
        },
        403,
      ),
    );

    let caught: unknown;
    try {
      await listContinuityFacilityGrants();
    } catch (error) {
      caught = error;
    }

    expect(classifyContinuityFacilityError(caught)).toEqual({
      state: "denied",
      status: 403,
      code: undefined,
      requestId: "req-cd14-403",
      message: "Only integration admins can manage devices",
    });
  });

  it("keeps a network failure in the generic unavailable state", () => {
    expect(
      classifyContinuityFacilityError(new TypeError("Failed to fetch")),
    ).toEqual({
      state: "service_unavailable",
      status: undefined,
      code: undefined,
      requestId: undefined,
      message: "Failed to fetch",
    });
  });
});
