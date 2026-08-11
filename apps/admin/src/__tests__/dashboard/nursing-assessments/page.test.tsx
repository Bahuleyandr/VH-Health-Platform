import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import NursingAssessmentsPage from "@/app/(with-auth)/dashboard/nursing-assessments/page";
import { fetchAdminAPI } from "@/lib/api";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<
  typeof fetchAdminAPI
>;

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NursingAssessmentsPage />
    </QueryClientProvider>,
  );
}

describe("<NursingAssessmentsPage /> partial NEWS2 presentation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchAdminAPI.mockImplementation(async (path, init) => {
      if (!init && String(path).startsWith("/nursing-assessments/dashboard/")) {
        return [{
          id: 41,
          patient_uid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          admission_id: null,
          assessment_kind: "news2",
          total_score: 0,
          band: null,
          partial_score: true,
          risk_band_available: false,
          missing_params: ["spo2", "temperature"],
          assessed_at: "2026-08-11T08:00:00.000Z",
          next_assessment_due_at: null,
          minutes_overdue: 0,
        }] as never;
      }
      if (init?.method === "POST" && path === "/nursing-assessments/score") {
        return {
          total_score: 0,
          band: null,
          recommended_actions: null,
          reassessmentMins: null,
          partial: true,
          risk_band_available: false,
          missing: ["spo2", "temperature", "systolic_bp", "heart_rate", "consciousness"],
        } as never;
      }
      return [] as never;
    });
  });

  it("renders stored and preview partial scores explicitly without low-risk reassurance", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("Partial — risk band unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ NEWS2" }));
    await user.click(screen.getByRole("button", { name: "Preview score" }));

    expect(await screen.findByText(/Score 0 — Partial; risk band unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/Complete the missing observations/i)).toBeInTheDocument();
    expect(screen.queryByText(/Continue routine monitoring/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^LOW$/i)).not.toBeInTheDocument();
  });
});
