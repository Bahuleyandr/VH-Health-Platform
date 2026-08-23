
import CarePathwaysPage from "@/app/(with-auth)/dashboard/care-pathways/page";
import { getCarePathwayReconciliationEvidence } from "@/lib/api/carePathways";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/carePathways", () => ({
  getCarePathwayReconciliationEvidence: jest.fn(),
}));

const CLEAN_ROW = {
  id: "1",
  sweep_id: "30000000-0000-4000-8000-000000000001",
  pathway_key: "diagnostics_order_to_action",
  pathway_mode: "shadow" as const,
  registry_version: 3,
  registry_checksum: "a".repeat(64),
  governance_checksum: "b".repeat(64),
  governance_count: 1,
  covered_governance_count: 1,
  expected_check_count: 16,
  executed_check_count: 16,
  finding_count: 0,
  repair_count: 0,
  error_count: 0,
  registry_complete: true,
  passed: true,
  check_results: [],
  started_at: "2026-07-23T08:00:00.000Z",
  completed_at: "2026-07-23T08:00:01.000Z",
  created_at: "2026-07-23T08:00:01.000Z",
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CarePathwaysPage />
    </QueryClientProvider>,
  );
}

describe("Care pathway evidence page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getCarePathwayReconciliationEvidence as jest.Mock).mockResolvedValue({
      evidence: [CLEAN_ROW],
      count: 1,
      limit: 50,
      offset: 0,
    });
  });

  it("shows clean Diagnostics evidence without offering activation", async () => {
    renderPage();
    expect(await screen.findByText("Diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Clean shadow evidence")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /activate/i })).not.toBeInTheDocument();
  });

  it("loads bounded history only when the operator selects it", async () => {
    renderPage();
    await screen.findByText("Diagnostics");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await waitFor(() => {
      expect(getCarePathwayReconciliationEvidence).toHaveBeenCalledWith("history");
    });
  });
});
