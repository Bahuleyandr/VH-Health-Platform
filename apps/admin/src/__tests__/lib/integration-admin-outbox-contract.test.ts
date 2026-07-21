import {
  enqueueDelivery,
  markDeliveryDead,
  redriveDelivery,
} from "@/lib/api/integrationAdmin";
import { fetchAdminAPI, postJSON } from "@/lib/api/core";

jest.mock("@/lib/api/core", () => ({
  fetchAdminAPI: jest.fn(),
  getJSON: jest.fn(),
  postJSON: jest.fn(),
}));

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;
const mockedPostJSON = postJSON as jest.MockedFunction<typeof postJSON>;

describe("integration admin outbox recovery contract", () => {
  beforeEach(() => {
    mockedFetchAdminAPI.mockReset();
    mockedPostJSON.mockReset();
  });

  it("does not let ad-hoc webhook enqueue impersonate a source outbox event", async () => {
    mockedPostJSON.mockResolvedValue({ matched: 0, enqueued: [] });

    await enqueueDelivery({ event_type: "patient.updated", payload: { patient_uid: "p-1" } });

    expect(mockedPostJSON).toHaveBeenCalledWith("/admin/webhook-deliveries/enqueue", {
      event_type: "patient.updated",
      payload: { patient_uid: "p-1" },
    });
  });

  it("sends the operator reason when marking a delivery dead", async () => {
    mockedFetchAdminAPI.mockResolvedValue({});

    await markDeliveryDead(42, { reason: "subscription owner confirmed retirement" });

    expect(mockedFetchAdminAPI).toHaveBeenCalledWith(
      "/admin/webhook-deliveries/42/mark-dead",
      {
        method: "PATCH",
        body: { reason: "subscription owner confirmed retirement" },
      },
    );
  });

  it("sends the operator reason when redriving a dead delivery", async () => {
    mockedPostJSON.mockResolvedValue({});

    await redriveDelivery(42, { reason: "endpoint health restored" });

    expect(mockedPostJSON).toHaveBeenCalledWith(
      "/admin/webhook-deliveries/42/redrive",
      { reason: "endpoint health restored" },
    );
  });
});
