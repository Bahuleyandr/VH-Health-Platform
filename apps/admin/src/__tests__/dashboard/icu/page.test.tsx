import FlowsheetTab from "@/app/(with-auth)/dashboard/icu/components/FlowsheetTab";
import ICUPage from "@/app/(with-auth)/dashboard/icu/page";
import { fetchAdminAPI } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));

const mockRealtime = jest.fn(
   
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

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<
  typeof fetchAdminAPI
>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<ICUPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtime.mockReturnValue({
      connected: false,
      subscribed: false,
      denied: null,
      lastEventAt: null,
    });
    mockedFetchAdminAPI.mockResolvedValue([] as never); // /icu/admissions -> []
  });

  it("subscribes to staff:icu-board and shows ○ Polling when not live", async () => {
    renderWithQuery(<ICUPage />);
    const ind = await screen.findByTestId("icu-realtime-indicator");
    expect(ind).toHaveTextContent("Polling");
    expect(mockRealtime).toHaveBeenCalledWith("staff:icu-board", [["icu"]]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({
      connected: true,
      subscribed: true,
      denied: null,
      lastEventAt: Date.now(),
    });
    renderWithQuery(<ICUPage />);
    const ind = await screen.findByTestId("icu-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });

  it("renders ICU chart depth from device and lifecycle sources", async () => {
    mockedFetchAdminAPI.mockImplementation(async (url: string) => {
      if (url.includes("/chart")) {
        return {
          data: {
            summary: {
              manual_flowsheet_count: 1,
              device_vitals_count: 2,
              unverified_device_vitals_count: 1,
              active_line_count: 1,
              active_denominator_device_count: 1,
              ventilation_episode_count: 1,
              weaning_trial_count: 1,
              scoring_output_count: 1,
            },
            device_vitals: [
              {
                id: 11,
                recorded_at: "2026-07-09T09:00:00.000Z",
                heart_rate: 88,
                systolic_bp: 120,
                diastolic_bp: 76,
                spo2: 96,
                respiratory_rate: 18,
                source_device: "Bedside monitor",
                device_verified: false,
                verified_at: null,
              },
            ],
            ventilation_episodes: [
              {
                id: 7,
                mode: "pressure_support",
                oxygen_device: "ventilator",
                airway_type: "ett",
                started_at: "2026-07-09T08:00:00.000Z",
                stopped_at: null,
                stop_reason: null,
              },
            ],
            weaning_trials: [],
            line_presence: [
              {
                id: 9,
                presence_kind: "central_line",
                display_label: "Right IJ central line",
                site: "right ij",
                denominator_device_type: "central_line",
                device_presence_log_id: 3,
                started_at: "2026-07-09T08:15:00.000Z",
                stopped_at: null,
              },
            ],
            scoring_outputs: [
              {
                id: 5,
                scoring_kind: "sofa",
                score_value: 6,
                score_label: null,
                reference_source: "content_studio",
                reference_version: "v1",
                review_status: "reviewed",
                protocol_available: true,
                order_mutation_performed: false,
                recorded_at: "2026-07-09T09:10:00.000Z",
              },
            ],
          },
        } as never;
      }
      return { data: [] } as never;
    });

    renderWithQuery(<FlowsheetTab admissionId={42} subscribed={false} />);

    expect(await screen.findByText("ICU chart depth")).toBeInTheDocument();
    expect(screen.getByText("Device vitals 2")).toBeInTheDocument();
    expect(screen.getByText("Unverified 1")).toBeInTheDocument();
    expect(screen.getByText(/Right IJ central line/)).toBeInTheDocument();
    expect(screen.getByText(/decision support only/)).toBeInTheDocument();
  });
});
