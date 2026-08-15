import {
  confirmBooking,
  dispatchCollectorBooking,
  getBookingQueue,
  getBookingSLA,
  getInvestigationsList,
  getSLADashboard,
  getTestCatalog,
  markBookingCollected,
  orderInvestigation,
  startBookingProcessing,
  updateInvestigationStatus,
  upsertTestCatalog,
} from "@/lib/api/investigations";
import { getJSON, postJSON, putJSON } from "@/lib/api/core";

jest.mock("@/lib/api/core", () => ({
  getJSON: jest.fn(),
  postJSON: jest.fn(),
  putJSON: jest.fn(),
}));

const mockedGetJSON = getJSON as jest.MockedFunction<typeof getJSON>;
const mockedPostJSON = postJSON as jest.MockedFunction<typeof postJSON>;
const mockedPutJSON = putJSON as jest.MockedFunction<typeof putJSON>;

describe("investigations api contract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes category query param to getTestCatalog", async () => {
    mockedGetJSON.mockResolvedValueOnce([]);

    await getTestCatalog("LAB");

    expect(mockedGetJSON).toHaveBeenCalledWith(
      "/api/v1/investigations/catalog",
      {
        category: "LAB",
      },
    );
  });

  it("maps date filters to from_date/to_date in getBookingSLA", async () => {
    mockedGetJSON.mockResolvedValueOnce({ summary: {} } as unknown);

    await getBookingSLA("2026-04-01", "2026-04-15");

    expect(mockedGetJSON).toHaveBeenCalledWith(
      "/api/v1/investigations/bookings/sla",
      { from_date: "2026-04-01", to_date: "2026-04-15" },
    );
  });

  it("sends empty payload by default for markBookingCollected", async () => {
    mockedPostJSON.mockResolvedValueOnce({} as never);

    await markBookingCollected(42);

    expect(mockedPostJSON).toHaveBeenCalledWith(
      "/api/v1/investigations/bookings/42/collected",
      {},
    );
  });

  it("uses status endpoint shape for updateInvestigationStatus", async () => {
    mockedPutJSON.mockResolvedValueOnce({} as never);

    await updateInvestigationStatus(8, "processing");

    expect(mockedPutJSON).toHaveBeenCalledWith(
      "/api/v1/investigations/8/status",
      { status: "processing" },
    );
  });

  it("forwards pagination params to getInvestigationsList", async () => {
    mockedGetJSON.mockResolvedValueOnce({
      investigations: [],
      pagination: {},
    } as never);

    await getInvestigationsList({ page: 2, status: "pending" });

    expect(mockedGetJSON).toHaveBeenCalledWith("/api/v1/investigations/list", {
      page: 2,
      status: "pending",
    });
  });

  it("posts catalog payload for upsertTestCatalog", async () => {
    mockedPostJSON.mockResolvedValueOnce({} as never);

    await upsertTestCatalog({ name: "CBC", category: "LAB" });

    expect(mockedPostJSON).toHaveBeenCalledWith(
      "/api/v1/investigations/catalog",
      { name: "CBC", category: "LAB" },
    );
  });

  it("maps date filters to from_date/to_date in getSLADashboard", async () => {
    mockedGetJSON.mockResolvedValueOnce({ summary: {} } as never);

    await getSLADashboard("2026-04-01", "2026-04-15");

    expect(mockedGetJSON).toHaveBeenCalledWith(
      "/api/v1/investigations/sla-dashboard",
      { from_date: "2026-04-01", to_date: "2026-04-15" },
    );
  });

  it("posts the order payload for orderInvestigation", async () => {
    mockedPostJSON.mockResolvedValueOnce({} as never);

    await orderInvestigation({
      patient_id: 5,
      test_name: "CBC",
      type: "lab",
      priority: "urgent",
    });

    expect(mockedPostJSON).toHaveBeenCalledWith(
      "/api/v1/investigations/order",
      {
        patient_id: 5,
        test_name: "CBC",
        type: "lab",
        priority: "urgent",
      },
    );
  });

  it("forwards queue filters to getBookingQueue", async () => {
    mockedGetJSON.mockResolvedValueOnce([] as never);

    await getBookingQueue({ status: "booked" });

    expect(mockedGetJSON).toHaveBeenCalledWith(
      "/api/v1/investigations/bookings/queue",
      { status: "booked" },
    );
  });

  it("posts confirmation details for confirmBooking", async () => {
    mockedPostJSON.mockResolvedValueOnce({} as never);

    await confirmBooking(9, { confirmation_notes: "ok", final_cost: 1200 });

    expect(mockedPostJSON).toHaveBeenCalledWith(
      "/api/v1/investigations/bookings/9/confirm",
      { confirmation_notes: "ok", final_cost: 1200 },
    );
  });

  it("posts collector assignment for dispatchCollectorBooking", async () => {
    mockedPostJSON.mockResolvedValueOnce({} as never);

    await dispatchCollectorBooking(9, {
      assigned_collector: 3,
      collector_phone: "9999999999",
    });

    expect(mockedPostJSON).toHaveBeenCalledWith(
      "/api/v1/investigations/bookings/9/dispatch",
      { assigned_collector: 3, collector_phone: "9999999999" },
    );
  });

  it("posts an empty body for startBookingProcessing", async () => {
    mockedPostJSON.mockResolvedValueOnce({} as never);

    await startBookingProcessing(9);

    expect(mockedPostJSON).toHaveBeenCalledWith(
      "/api/v1/investigations/bookings/9/processing",
      {},
    );
  });
});
