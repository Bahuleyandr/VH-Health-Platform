
import ClinicalGovernancePage from "@/app/(with-auth)/dashboard/clinical-governance/page";
import {
  addCareTeamMember,
  createCareTeam,
  createLabSpecimen,
  downloadPatientAccessShadowDenialsCsv,
  listCareTeamMembers,
  listCareTeams,
  listLabAnalyzers,
  listLabQcRuns,
  listLabSpecimens,
  listPatientAccessAudit,
  listPatientAccessShadowDenials,
  recordLabQcRun,
  saveLabAnalyzer,
  startPatientBreakGlass,
  transitionCareTeam,
  transitionCareTeamMember,
  transitionLabSpecimen,
} from "@/lib/api/clinicalGovernance";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/clinicalGovernance", () => ({
  addCareTeamMember: jest.fn(),
  createCareTeam: jest.fn(),
  createLabSpecimen: jest.fn(),
  downloadPatientAccessShadowDenialsCsv: jest.fn(),
  listCareTeamMembers: jest.fn(),
  listCareTeams: jest.fn(),
  listLabAnalyzers: jest.fn(),
  listLabQcRuns: jest.fn(),
  listLabSpecimens: jest.fn(),
  listPatientAccessAudit: jest.fn(),
  listPatientAccessShadowDenials: jest.fn(),
  recordLabQcRun: jest.fn(),
  saveLabAnalyzer: jest.fn(),
  startPatientBreakGlass: jest.fn(),
  transitionCareTeam: jest.fn(),
  transitionCareTeamMember: jest.fn(),
  transitionLabSpecimen: jest.fn(),
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ClinicalGovernancePage />
    </QueryClientProvider>,
  );
}

describe("<ClinicalGovernancePage /> shadow denials tab", () => {
  const createObjectURL = jest.fn(() => "blob:shadow-denials");
  const revokeObjectURL = jest.fn();
  let clickSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (listCareTeams as jest.Mock).mockResolvedValue({ care_teams: [], count: 0 });
    (listCareTeamMembers as jest.Mock).mockResolvedValue({ members: [], count: 0 });
    (listPatientAccessAudit as jest.Mock).mockResolvedValue({ access_events: [], count: 0 });
    (listLabSpecimens as jest.Mock).mockResolvedValue({ specimens: [], count: 0 });
    (listLabAnalyzers as jest.Mock).mockResolvedValue({ analyzers: [], count: 0 });
    (listLabQcRuns as jest.Mock).mockResolvedValue({ qc_runs: [], count: 0 });
    (listPatientAccessShadowDenials as jest.Mock).mockResolvedValue({
      range: { date_from: "2026-07-01", date_to: "2026-07-02" },
      count: 1,
      total_denials: 3,
      shadow_denials: [{
        day: "2026-07-01",
        actor_role: "DOCTOR",
        resource_family: "PRESCRIPTION",
        denial_count: 3,
        first_seen_at: "2026-07-01T03:45:00.000Z",
        last_seen_at: "2026-07-01T04:35:00.000Z",
      }],
    });
    (downloadPatientAccessShadowDenialsCsv as jest.Mock).mockResolvedValue(
      new Blob(["day,actor_role\n2026-07-01,DOCTOR"], { type: "text/csv" }),
    );
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      writable: true,
      configurable: true,
    });
    clickSpy = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    (createCareTeam as jest.Mock).mockResolvedValue({});
    (transitionCareTeam as jest.Mock).mockResolvedValue({});
    (addCareTeamMember as jest.Mock).mockResolvedValue({});
    (transitionCareTeamMember as jest.Mock).mockResolvedValue({});
    (startPatientBreakGlass as jest.Mock).mockResolvedValue({});
    (createLabSpecimen as jest.Mock).mockResolvedValue({});
    (transitionLabSpecimen as jest.Mock).mockResolvedValue({});
    (saveLabAnalyzer as jest.Mock).mockResolvedValue({});
    (recordLabQcRun as jest.Mock).mockResolvedValue({});
  });

  afterEach(() => {
    clickSpy.mockRestore();
  });

  it("renders the shadow-denials report and downloads CSV for the selected date range", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /Shadow denials/ }));

    await screen.findByText("PRESCRIPTION");
    expect(screen.getByText("DOCTOR")).toBeInTheDocument();
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Shadow denial from date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("Shadow denial to date"), {
      target: { value: "2026-07-02" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/ }));

    await waitFor(() =>
      expect(downloadPatientAccessShadowDenialsCsv).toHaveBeenCalledWith({
        date_from: "2026-07-01",
        date_to: "2026-07-02",
      }),
    );
    expect(clickSpy).toHaveBeenCalled();
  });
});
