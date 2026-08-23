import {
  CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE,
  classifyContinuityFacilityError,
  listContinuityFacilityGrants,
  orchestrateContinuityDeviceLoss,
} from "@/lib/api/continuityFacilityContext";
import { APIError } from "@/lib/api/core";
import { apiFetch } from "@/lib/api-fetch";

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

  it("sends one typed device-loss body with the stable idempotency header", async () => {
    const operation = {
      operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      state: "awaiting_device_contact",
      stable_device_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      incident_reference: "INC-2042",
      idempotent_replay: false,
      subjects: [],
      steps: [],
      wipe_order: null,
      request_id: "req-device-loss",
    };
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, data: operation }, 202),
    );

    const result = await orchestrateContinuityDeviceLoss(
      {
        stable_device_id: operation.stable_device_id,
        affected_staff_uids: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
        incident_reference: operation.incident_reference,
        reason: "Reported stolen",
      },
      "device-loss-retry-key",
    );

    expect(result.data).toEqual(operation);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/admin/devices/continuity-device-loss",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          stable_device_id: operation.stable_device_id,
          affected_staff_uids: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
          incident_reference: operation.incident_reference,
          reason: "Reported stolen",
        }),
        headers: expect.any(Headers),
      }),
    );
    const headers = (mockedApiFetch.mock.calls[0]?.[1]?.headers as Headers);
    expect(headers.get("Idempotency-Key")).toBe("device-loss-retry-key");
    expect(headers.get("Content-Type")).toBe("application/json");
  });
});
