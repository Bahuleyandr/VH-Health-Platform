import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import EdTrackerPage from "@/app/(with-auth)/dashboard/ed-tracker/page";
import { fetchAdminAPI } from "@/lib/api";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn(),
}));

const mockRealtime = jest.fn(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (..._args: unknown[]) => ({
    connected: false,
    subscribed: false,
    denied: null as string | null,
    lastEventAt: null as number | null,
  }),
);
jest.mock("@/hooks/useRealtimeInvalidation", () => ({
  useRealtimeInvalidation: (...args: unknown[]) => mockRealtime(...args),
}));

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<EdTrackerPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({ connected: false, subscribed: false, denied: null, lastEventAt: null });
    mockedFetchAdminAPI.mockImplementation(async () => {
      return [
        {
          id: 1, visit_number: "ED-001", patient_uid: null,
          arrival_at: "2026-06-27T10:00:00.000Z", arrival_mode: "walk_in",
          chief_complaint: "Chest pain", attending_doctor_uid: null,
          triage_priority: "esi_2", status: "in_triage",
          bed_assigned_id: null, disposition: null,
          triage_started_at: null, treatment_started_at: null,
          disposition_at: null, is_mlc: false,
        },
      ] as never;
    });
  });

  it("subscribes to admin:ed-board and shows ○ Polling when not live", async () => {
    renderWithQuery(<EdTrackerPage />);
    const ind = await screen.findByTestId("ed-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("admin:ed-board", [["ed"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({ connected: true, subscribed: true, denied: null, lastEventAt: Date.now() });
    renderWithQuery(<EdTrackerPage />);
    const ind = await screen.findByTestId("ed-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });
});
