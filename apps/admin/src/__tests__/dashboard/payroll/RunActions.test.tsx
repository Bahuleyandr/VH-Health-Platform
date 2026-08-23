/**
 * Tests for src/app/(with-auth)/dashboard/payroll/components/RunActions.tsx
 *
 * The RunActions component is a mini state machine driven by
 * PayrollRun.status + hr_approved_at + admin_approved_at. It decides which
 * of four paths to show: HR Sign → Admin Countersign → Issue to Staff →
 * (done). Getting this wrong means an approved run can't be issued (stuck
 * payroll) or a locked run shows a dangerous "re-issue" button — both are
 * on the clinical-safety-adjacent severity band, because staff stop getting
 * paid.
 *
 * R7 (2026-08-10 audit): 'completed_with_errors' runs (migration 644) must be
 * signable too — previously the component rendered nothing for them, so a
 * month with one failed payslip could never be signed. The backend requires
 * `acknowledge_failed_payslips: true` on sign/countersign/issue for such runs;
 * the component must show WHO failed and gate the action behind an explicit
 * checkbox before sending that flag.
 *
 * The underlying mutations need a live @tanstack/react-query client, so
 * each test wraps the component in a fresh QueryClientProvider.
 */

import { RunActions } from "@/app/(with-auth)/dashboard/payroll/components/RunActions";
import type { PayrollRun } from "@/lib/api/payroll";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/payroll", () => ({
  hrSignPayrollRun: jest.fn(async () => ({})),
  adminSignPayrollRun: jest.fn(async () => ({})),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const payrollApi = require("@/lib/api/payroll") as {
  hrSignPayrollRun: jest.Mock;
  adminSignPayrollRun: jest.Mock;
};

function withQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function baseRun(overrides: Partial<PayrollRun> = {}): PayrollRun {
  return {
    id: 1,
    month: 4,
    year: 2026,
    total_staff: 10,
    total_gross: "100000",
    total_net: "85000",
    status: "completed",
    generated_by_name: "Alice",
    hr_approved_at: null,
    admin_approved_at: null,
    ...overrides,
  } as PayrollRun;
}

function runWithFailures(overrides: Partial<PayrollRun> = {}): PayrollRun {
  return baseRun({
    status: "completed_with_errors",
    failed_staff_count: 2,
    failed_staff_summary: [
      { staff_uid: "uid-a", name: "Bad Nurse" },
      { staff_uid: "uid-b", name: "Sad Porter" },
    ],
    ...overrides,
  });
}

// A minimal useMutation return-object shape acceptable to TS. Parameter
// type must match the RunActions issueMut prop.
type IssueVariables = { month: number; year: number; acknowledge_failed_payslips?: boolean };
type IssueMut = ReturnType<typeof useMutation<unknown, Error, IssueVariables>>;
function makeIssueMut(spy?: jest.Mock) {
  function Wrapper({ children }: { children: (m: IssueMut) => React.ReactElement }) {
    const m = useMutation<unknown, Error, IssueVariables>({
      mutationFn: async (variables) => {
        spy?.(variables);
        return {};
      },
    });
    return children(m);
  }
  return Wrapper;
}

beforeEach(() => {
  payrollApi.hrSignPayrollRun.mockClear();
  payrollApi.adminSignPayrollRun.mockClear();
});

describe("<RunActions />", () => {
  it("status=completed + no HR signature → shows 'HR Sign' CTA", () => {
    const IssueWrapper = makeIssueMut();
    render(
      withQueryClient(
        <IssueWrapper>
          {(issueMut) => <RunActions run={baseRun({ status: "completed" })} issueMut={issueMut} />}
        </IssueWrapper>,
      ),
    );
    expect(screen.getByRole("button", { name: /HR Sign/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Countersign/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Issue/ })).not.toBeInTheDocument();
  });

  it("status=completed + HR-signed + no Admin → shows 'Admin Countersign' CTA and 'HR Signed' badge", () => {
    const IssueWrapper = makeIssueMut();
    render(
      withQueryClient(
        <IssueWrapper>
          {(issueMut) => (
            <RunActions
              run={baseRun({
                status: "completed",
                hr_approved_at: "2026-04-16T10:00:00Z",
                admin_approved_at: null,
              })}
              issueMut={issueMut}
            />
          )}
        </IssueWrapper>,
      ),
    );
    expect(screen.getByText(/HR Signed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Admin Countersign/ })).toBeInTheDocument();
  });

  it("status=approved → shows 'Issue to Staff' CTA", () => {
    const IssueWrapper = makeIssueMut();
    render(
      withQueryClient(
        <IssueWrapper>
          {(issueMut) => (
            <RunActions
              run={baseRun({
                status: "approved",
                hr_approved_at: "2026-04-16T10:00:00Z",
                admin_approved_at: "2026-04-16T11:00:00Z",
              })}
              issueMut={issueMut}
            />
          )}
        </IssueWrapper>,
      ),
    );
    expect(screen.getByText(/HR \+ Admin signed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Issue to Staff/ })).toBeInTheDocument();
  });

  it("status=locked → shows '✓ Issued', NO action buttons (dangerous re-issue blocked)", () => {
    const IssueWrapper = makeIssueMut();
    render(
      withQueryClient(
        <IssueWrapper>
          {(issueMut) => (
            <RunActions
              run={baseRun({
                status: "locked",
                hr_approved_at: "2026-04-16T10:00:00Z",
                admin_approved_at: "2026-04-16T11:00:00Z",
              })}
              issueMut={issueMut}
            />
          )}
        </IssueWrapper>,
      ),
    );
    expect(screen.getByText(/Issued/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("status=draft → renders nothing (run not ready for any action)", () => {
    const IssueWrapper = makeIssueMut();
    const { container } = render(
      withQueryClient(
        <IssueWrapper>
          {(issueMut) => <RunActions run={baseRun({ status: "draft" })} issueMut={issueMut} />}
        </IssueWrapper>,
      ),
    );
    // The wrapper still renders, but RunActions itself returns null.
    // Check no HR/Admin/Issue buttons leaked.
    expect(screen.queryByRole("button", { name: /HR Sign/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Countersign/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Issue/ })).not.toBeInTheDocument();
    // Verify RunActions itself returned null (no wrapper divs from it).
    expect(container.textContent).toBe("");
  });
});

describe("<RunActions /> completed_with_errors acknowledgement (R7)", () => {
  it("status=completed_with_errors → HR Sign CTA shows (run is no longer unsignable)", () => {
    const IssueWrapper = makeIssueMut();
    render(
      withQueryClient(
        <IssueWrapper>
          {(issueMut) => <RunActions run={runWithFailures()} issueMut={issueMut} />}
        </IssueWrapper>,
      ),
    );
    expect(screen.getByRole("button", { name: /HR Sign/ })).toBeInTheDocument();
  });

  it("HR sign panel lists the failed staff and keeps Confirm disabled until acknowledged", () => {
    const IssueWrapper = makeIssueMut();
    render(
      withQueryClient(
        <IssueWrapper>
          {(issueMut) => <RunActions run={runWithFailures()} issueMut={issueMut} />}
        </IssueWrapper>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /HR Sign/ }));

    // The signer sees which payslips failed…
    expect(screen.getByText(/2 payslips failed in this run/)).toBeInTheDocument();
    expect(screen.getByText("Bad Nurse")).toBeInTheDocument();
    expect(screen.getByText("Sad Porter")).toBeInTheDocument();

    // …and cannot confirm until the acknowledgement is ticked.
    const confirm = screen.getByRole("button", { name: /Confirm HR Sign/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(confirm).toBeEnabled();
  });

  it("acknowledged HR sign sends acknowledge_failed_payslips: true", async () => {
    const IssueWrapper = makeIssueMut();
    render(
      withQueryClient(
        <IssueWrapper>
          {(issueMut) => <RunActions run={runWithFailures()} issueMut={issueMut} />}
        </IssueWrapper>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /HR Sign/ }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Confirm HR Sign/ }));

    await waitFor(() =>
      expect(payrollApi.hrSignPayrollRun).toHaveBeenCalledWith("1", {
        comment: "",
        acknowledge_failed_payslips: true,
      }),
    );
  });

  it("a clean completed run signs WITHOUT the ack flag (unchanged behaviour)", async () => {
    const IssueWrapper = makeIssueMut();
    render(
      withQueryClient(
        <IssueWrapper>
          {(issueMut) => <RunActions run={baseRun()} issueMut={issueMut} />}
        </IssueWrapper>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /HR Sign/ }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Confirm HR Sign/ }));

    await waitFor(() =>
      expect(payrollApi.hrSignPayrollRun).toHaveBeenCalledWith("1", { comment: "" }),
    );
  });

  it("countersign of a completed_with_errors run requires its own acknowledgement", async () => {
    const IssueWrapper = makeIssueMut();
    render(
      withQueryClient(
        <IssueWrapper>
          {(issueMut) => (
            <RunActions
              run={runWithFailures({ hr_approved_at: "2026-04-16T10:00:00Z" })}
              issueMut={issueMut}
            />
          )}
        </IssueWrapper>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /Admin Countersign/ }));

    const confirm = screen.getByRole("button", { name: /^Countersign$/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(payrollApi.adminSignPayrollRun).toHaveBeenCalledWith("1", {
        comment: "",
        acknowledge_failed_payslips: true,
      }),
    );
  });

  it("issuing an approved run with failed payslips requires the ack and sends the flag", async () => {
    const issueSpy = jest.fn();
    const IssueWrapper = makeIssueMut(issueSpy);
    render(
      withQueryClient(
        <IssueWrapper>
          {(issueMut) => (
            <RunActions
              run={runWithFailures({
                status: "approved",
                hr_approved_at: "2026-04-16T10:00:00Z",
                admin_approved_at: "2026-04-16T11:00:00Z",
              })}
              issueMut={issueMut}
            />
          )}
        </IssueWrapper>,
      ),
    );
    // First click only opens the confirmation — nothing is issued yet.
    fireEvent.click(screen.getByRole("button", { name: /Issue to Staff/ }));
    expect(issueSpy).not.toHaveBeenCalled();

    const confirm = screen.getByRole("button", { name: /Confirm Issue/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(issueSpy).toHaveBeenCalledWith({
        month: 4,
        year: 2026,
        acknowledge_failed_payslips: true,
      }),
    );
  });

  it("issuing a clean approved run stays one-click with no ack flag", async () => {
    const issueSpy = jest.fn();
    const IssueWrapper = makeIssueMut(issueSpy);
    render(
      withQueryClient(
        <IssueWrapper>
          {(issueMut) => (
            <RunActions
              run={baseRun({
                status: "approved",
                hr_approved_at: "2026-04-16T10:00:00Z",
                admin_approved_at: "2026-04-16T11:00:00Z",
              })}
              issueMut={issueMut}
            />
          )}
        </IssueWrapper>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /Issue to Staff/ }));

    await waitFor(() => expect(issueSpy).toHaveBeenCalledWith({ month: 4, year: 2026 }));
  });
});
