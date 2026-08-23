import WorkflowEscalationsPage from "@/app/(with-auth)/dashboard/workflow-escalations/page";
import {
  listApprovals,
  listEscalationRules,
  listSlaDefinitions,
  listWorkflowRuns,
  saveEscalationRule,
} from "@/lib/api/workflowEscalations";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/workflowEscalations", () => {
  const actual = jest.requireActual("@/lib/api/workflowEscalations");
  return {
    ...actual,
    listApprovals: jest.fn(),
    listEscalationRules: jest.fn(),
    listSlaDefinitions: jest.fn(),
    listWorkflowRuns: jest.fn(),
    saveEscalationRule: jest.fn(),
  };
});

jest.mock("react-hot-toast", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const RULE = {
  id: 11,
  tenant_id: "35353535-3535-4353-8535-353535353503",
  display_name: "Critical lab SLA breach",
  description: "Page on-call clinicians when a critical result SLA breaches",
  scope: "task" as const,
  match_filter: { task_kind: "critical_result_ack" },
  trigger_condition: "sla_breach" as const,
  trigger_window_minutes: 15,
  action_kind: "notify" as const,
  action_payload: { roles: ["DOCTOR", "NURSE"] },
  is_active: true,
  created_by: null,
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-02T10:00:00.000Z",
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WorkflowEscalationsPage />
    </QueryClientProvider>,
  );
}

describe("<WorkflowEscalationsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listEscalationRules as jest.Mock).mockResolvedValue({
      rules: [RULE],
      count: 1,
    });
    (listSlaDefinitions as jest.Mock).mockResolvedValue({
      count: 1,
      slas: [
        {
          id: 1,
          tenant_id: RULE.tenant_id,
          sla_key: "critical-result-ack",
          display_name: "Critical result acknowledgement",
          description: null,
          target_minutes: 30,
          warn_at_pct: 75,
          business_hours_only: false,
          metadata: null,
          created_at: "2026-08-01T10:00:00.000Z",
          updated_at: "2026-08-01T10:00:00.000Z",
        },
      ],
    });
    (listWorkflowRuns as jest.Mock).mockResolvedValue({ runs: [], count: 0 });
    (listApprovals as jest.Mock).mockResolvedValue({ approvals: [], count: 0 });
    (saveEscalationRule as jest.Mock).mockResolvedValue({ ...RULE });
  });

  it("shows the critical-result paging caution banner and the rules + SLA panels", async () => {
    renderPage();

    // Caution banner must warn before any edit is possible.
    expect(
      screen.getByText(/page clinicians on breached critical-result SLAs/i),
    ).toBeInTheDocument();

    await screen.findByText("Critical lab SLA breach");
    expect(screen.getByText(/roles: DOCTOR, NURSE/)).toBeInTheDocument();
    expect(await screen.findByText("critical-result-ack")).toBeInTheDocument();
    expect(listEscalationRules).toHaveBeenCalled();
  });

  it("edits a rule and drives the PUT upsert after the confirmation step", async () => {
    renderPage();
    await screen.findByText("Critical lab SLA breach");

    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const nameInput = await screen.findByLabelText("Display name");
    fireEvent.change(nameInput, {
      target: { value: "Critical lab SLA breach v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));

    // Confirmation restates the paging consequence before anything is sent.
    expect(
      await screen.findByText(
        /a wrong edit can silence a critical-result page/i,
      ),
    ).toBeInTheDocument();
    expect(saveEscalationRule).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm save" }));

    await waitFor(() =>
      expect(saveEscalationRule).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 11,
          display_name: "Critical lab SLA breach v2",
          scope: "task",
          trigger_condition: "sla_breach",
          trigger_window_minutes: 15,
          action_kind: "notify",
          action_payload: { roles: ["DOCTOR", "NURSE"] },
          is_active: true,
        }),
      ),
    );
  });
});
