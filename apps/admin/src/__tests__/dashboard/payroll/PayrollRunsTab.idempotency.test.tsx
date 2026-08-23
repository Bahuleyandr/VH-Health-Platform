// Regression guard for B1: the admin "Run Payroll" button was hard-400ing in
// production because `POST /staff/admin/payroll/run` mounts
// `requireIdempotencyKey({ required: true, scope: 'payroll_run' })` and
// `postJSON` had no way to send the header.
//
// These tests deliberately mock the TRANSPORT (`apiFetch`), not the payroll API
// module, so the real `payroll.ts` → `core.ts` path executes and the assertions
// are about what actually goes on the wire.

import { PayrollRunsTab } from "@/app/(with-auth)/dashboard/payroll/components/PayrollRunsTab";
import { apiFetch } from "@/lib/api-fetch";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotencyKey";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

jest.mock("@/lib/api-fetch", () => ({ apiFetch: jest.fn() }));
jest.mock("@/lib/browserNavigation", () => ({ navigateToLogin: jest.fn() }));
jest.mock("react-hot-toast", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const mockedApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

/** Every call to the run endpoint, in order, with its outgoing headers. */
function runCalls() {
  return mockedApiFetch.mock.calls.filter(
    ([url]) => String(url) === "/api/v1/staff/admin/payroll/run",
  );
}

function headerOf(call: [unknown, ...unknown[]]): string | null {
  const init = call[1] as RequestInit | undefined;
  return new Headers(init?.headers).get("Idempotency-Key");
}

function renderTab(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactElement = (
    <QueryClientProvider client={qc}>
      <PayrollRunsTab />
    </QueryClientProvider>
  );
  return render(ui);
}

async function openRunModal() {
  fireEvent.click(screen.getByRole("button", { name: "+ Run Payroll" }));
  return screen.findByRole("button", { name: /^Run Payroll for / });
}

/** The modal closes on success — waiting for that also proves onSuccess ran. */
async function waitForRunModalClosed() {
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /^Run Payroll for / }),
    ).toBeNull(),
  );
}

/** The button reads "Processing..." and is disabled while a run is in flight. */
async function waitForRunButtonIdle() {
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Run Payroll for / }),
    ).not.toBeDisabled(),
  );
}

describe("PayrollRunsTab — Idempotency-Key wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: the runs list is empty; the run endpoint succeeds.
    mockedApiFetch.mockImplementation(async (url: string) =>
      String(url) === "/api/v1/staff/admin/payroll/run"
        ? jsonResponse({ success: true, data: { run_id: 1, processed: 3 } })
        : jsonResponse({ success: true, data: [] }),
    );
  });

  it("sends an Idempotency-Key the backend will accept", async () => {
    renderTab();
    fireEvent.click(await openRunModal());

    await waitFor(() => expect(runCalls()).toHaveLength(1));
    const key = headerOf(runCalls()[0]);
    expect(key).not.toBeNull();
    expect(IDEMPOTENCY_KEY_PATTERN.test(key as string)).toBe(true);
    expect(key).toMatch(/^payroll-run:/);
  });

  it("reuses ONE key across retries of the same run — a replay, not a second run", async () => {
    // The endpoint fails transiently twice, so the operator clicks again. Every
    // attempt at the same {month, year} must carry the same key; otherwise the
    // request that actually reached the server would be re-executed.
    mockedApiFetch.mockImplementation(async (url: string) =>
      String(url) === "/api/v1/staff/admin/payroll/run"
        ? jsonResponse({ success: false, message: "upstream hiccup" }, 503)
        : jsonResponse({ success: true, data: [] }),
    );

    renderTab();
    await openRunModal();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await waitForRunButtonIdle();
      fireEvent.click(
        screen.getByRole("button", { name: /^Run Payroll for / }),
      );
      await waitFor(() => expect(runCalls()).toHaveLength(attempt));
    }

    const keys = runCalls().map(headerOf);
    expect(new Set(keys).size).toBe(1);
  });

  it("mints a NEW key once a run has succeeded — the next run really runs", async () => {
    renderTab();
    fireEvent.click(await openRunModal());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    await waitForRunModalClosed();
    const firstKey = headerOf(runCalls()[0]);

    // Modal closes on success; reopen and run the same month again. This is a
    // deliberate second run, so it must NOT be swallowed as a replay of the
    // first.
    fireEvent.click(await openRunModal());
    await waitFor(() => expect(runCalls()).toHaveLength(2));
    expect(headerOf(runCalls()[1])).not.toBe(firstKey);
  });

  it("mints a NEW key when the operator changes the month", async () => {
    renderTab();
    fireEvent.click(await openRunModal());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    await waitForRunModalClosed();
    const julyKey = headerOf(runCalls()[0]);

    await openRunModal();
    // Month is the first <select> in the run modal (the label is not
    // htmlFor-linked, so query by role and take the month one).
    const monthSelect = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    fireEvent.change(monthSelect, {
      target: { value: monthSelect.value === "1" ? "2" : "1" },
    });
    await waitForRunButtonIdle();
    fireEvent.click(screen.getByRole("button", { name: /^Run Payroll for / }));
    await waitFor(() => expect(runCalls()).toHaveLength(2));

    expect(headerOf(runCalls()[1])).not.toBe(julyKey);
    // A different month is a different request body; reusing the key would make
    // the backend answer 422 (body-hash mismatch) rather than run the month.
    expect(JSON.parse(String(runCalls()[1][1]?.body))).not.toEqual(
      JSON.parse(String(runCalls()[0][1]?.body)),
    );
  });
});
