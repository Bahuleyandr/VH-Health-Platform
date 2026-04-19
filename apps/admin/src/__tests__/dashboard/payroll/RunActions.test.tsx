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
 * The underlying mutations need a live @tanstack/react-query client, so
 * each test wraps the component in a fresh QueryClientProvider.
 */

import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import type { PayrollRun } from "@/lib/api/payroll";
import { RunActions } from "@/app/(with-auth)/dashboard/payroll/components/RunActions";

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

// A minimal useMutation return-object shape acceptable to TS. Parameter
// type must match the RunActions issueMut prop: (data: {month, year}) -> any.
type IssueVariables = { month: number; year: number };
type IssueMut = ReturnType<typeof useMutation<unknown, Error, IssueVariables>>;
function makeIssueMut() {
  function Wrapper({ children }: { children: (m: IssueMut) => React.ReactElement }) {
    const m = useMutation<unknown, Error, IssueVariables>({
      mutationFn: async () => ({}),
    });
    return children(m);
  }
  return Wrapper;
}

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
