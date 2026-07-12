import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import SystemAuditPage from "@/app/(with-auth)/dashboard/system-audit/page";
import { fetchAdminAPI, getJSON } from "@/lib/api/core";
import type { UnifiedAuditRow } from "@/app/(with-auth)/dashboard/system-audit/auditTypes";

// Mock the api core module (established repo lesson: mock the data module,
// never global fetch). `getJSON` keeps the default Live Feed tab quiet;
// `fetchAdminAPI` is what the Clinical Audit tab calls.
jest.mock("@/lib/api/core", () => ({
  getJSON: jest.fn(),
  fetchAdminAPI: jest.fn(),
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SystemAuditPage />
    </QueryClientProvider>,
  );
}

function openClinicalAuditTab() {
  fireEvent.click(screen.getByRole("button", { name: /Clinical Audit/ }));
}

function makeRow(over: Partial<UnifiedAuditRow> = {}): UnifiedAuditRow {
  return {
    source: "clinical",
    tenant_id: "tenant-1",
    id: "101",
    occurred_at: "2026-07-10T10:15:00.000Z",
    actor_uid: "doc-1",
    actor_role: "DOCTOR",
    patient_uid: "pat-9",
    action: "prescription.signed",
    action_status: "success",
    resource_type: "prescription",
    resource_table: "prescriptions",
    resource_id: "555",
    summary: "Prescription signed",
    metadata: {
      encounter_id: "enc-1",
      before_state: { status: "draft" },
      after_state: { status: "signed" },
    },
    ...over,
  };
}

function unifiedResponse(logs: UnifiedAuditRow[], offset = 0) {
  return {
    logs,
    limit: 25,
    offset,
    filters: {
      source: null,
      action: null,
      actor_uid: null,
      patient_uid: null,
      status: null,
      from: null,
      to: null,
      search: null,
    },
  };
}

describe("<SystemAuditPage /> clinical audit tab", () => {
  beforeEach(() => {
    (getJSON as jest.Mock).mockResolvedValue(null);
    (fetchAdminAPI as jest.Mock).mockResolvedValue(unifiedResponse([]));
  });

  it("shows a pre-search hint and does not fetch until a search is submitted", () => {
    renderPage();
    openClinicalAuditTab();

    expect(
      screen.getByText(/Search the unified clinical audit feed/i),
    ).toBeInTheDocument();
    expect(fetchAdminAPI).not.toHaveBeenCalled();
  });

  it("queries the unified endpoint with the submitted filters and renders source-labelled rows", async () => {
    (fetchAdminAPI as jest.Mock).mockResolvedValue(
      unifiedResponse([
        makeRow({
          source: "request",
          id: "r-1",
          actor_uid: "admin-7",
          actor_role: "ADMIN",
          patient_uid: null,
          action: "patients.list",
          action_status: "success",
          summary: "GET /api/v1/admin/patients",
          metadata: { method: "GET", path: "/api/v1/admin/patients" },
        }),
        makeRow({ source: "clinical", id: "c-1" }),
        makeRow({
          source: "patient_access",
          id: "p-1",
          actor_uid: "nurse-3",
          actor_role: "NURSE",
          patient_uid: "pat-7",
          action: "patient_record.view",
          action_status: "denied",
          summary: "care_team",
          metadata: { access_source: "care_team", route: "/records/9" },
        }),
      ]),
    );

    renderPage();
    openClinicalAuditTab();

    fireEvent.change(screen.getByLabelText("Filter by audit source"), {
      target: { value: "clinical" },
    });
    fireEvent.change(screen.getByLabelText("Filter by action"), {
      target: { value: "prescription" },
    });
    fireEvent.change(screen.getByLabelText("Filter by actor UID"), {
      target: { value: "doc-1" },
    });
    fireEvent.change(screen.getByLabelText("Filter by patient UID"), {
      target: { value: "pat-9" },
    });
    fireEvent.change(screen.getByLabelText("Events from date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("Events to date"), {
      target: { value: "2026-07-05" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));

    await waitFor(() =>
      expect(fetchAdminAPI).toHaveBeenCalledWith(
        "/admin/audit/unified?source=clinical&action=prescription&actor_uid=doc-1&patient_uid=pat-9&from=2026-07-01&to=2026-07-05&limit=25&offset=0",
      ),
    );

    // One clearly-labelled source chip per sink
    await screen.findByText("HTTP");
    expect(screen.getByText("Clinical")).toBeInTheDocument();
    expect(screen.getByText("Access")).toBeInTheDocument();

    // Actor (+role), patient, action, status
    expect(screen.getByText("admin-7")).toBeInTheDocument();
    expect(screen.getByText("DOCTOR")).toBeInTheDocument();
    expect(screen.getByText("pat-9")).toBeInTheDocument();
    expect(screen.getByText("prescription.signed")).toBeInTheDocument();
    expect(screen.getByText("denied")).toBeInTheDocument();
  });

  it("submits the search from the filter form (Enter key path)", async () => {
    renderPage();
    openClinicalAuditTab();

    fireEvent.change(screen.getByLabelText("Filter by patient UID"), {
      target: { value: "pat-42" },
    });
    fireEvent.submit(
      screen.getByRole("form", { name: /Clinical audit filters/i }),
    );

    await waitFor(() =>
      expect(fetchAdminAPI).toHaveBeenCalledWith(
        "/admin/audit/unified?patient_uid=pat-42&limit=25&offset=0",
      ),
    );
  });

  it("expands a row to reveal the event detail", async () => {
    (fetchAdminAPI as jest.Mock).mockResolvedValue(
      unifiedResponse([makeRow()]),
    );

    renderPage();
    openClinicalAuditTab();
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));

    const actionCell = await screen.findByText("prescription.signed");
    expect(screen.queryByText(/"after_state"/)).not.toBeInTheDocument();

    fireEvent.click(actionCell);

    expect(await screen.findByText(/"after_state"/)).toBeInTheDocument();
    expect(screen.getByText(/"signed"/)).toBeInTheDocument();
    expect(screen.getByText("prescriptions")).toBeInTheDocument();
    expect(screen.getByText("Prescription signed")).toBeInTheDocument();
  });

  it("shows the empty state when no events match", async () => {
    (fetchAdminAPI as jest.Mock).mockResolvedValue(unifiedResponse([]));

    renderPage();
    openClinicalAuditTab();
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));

    expect(
      await screen.findByText(/No audit events found/i),
    ).toBeInTheDocument();
  });

  it("shows a red error banner with the error message on failure", async () => {
    (fetchAdminAPI as jest.Mock).mockRejectedValue(
      new Error("backend exploded"),
    );

    renderPage();
    openClinicalAuditTab();
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));

    const message = await screen.findByText("backend exploded");
    expect(message.closest("div")?.className).toContain("bg-red-50");
  });

  it("advances pagination via offset and disables Next on a short page", async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) =>
      makeRow({ id: `a-${i}`, action: `page.one.${i}` }),
    );
    const shortPage = [
      makeRow({ id: "b-0", action: "page.two.0" }),
      makeRow({ id: "b-1", action: "page.two.1" }),
    ];
    (fetchAdminAPI as jest.Mock)
      .mockResolvedValueOnce(unifiedResponse(fullPage))
      .mockResolvedValueOnce(unifiedResponse(shortPage, 25));

    renderPage();
    openClinicalAuditTab();
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));

    await screen.findByText("page.one.0");
    const nextButton = screen.getByRole("button", { name: /Next/ });
    expect(nextButton).toBeEnabled();
    expect(screen.getByRole("button", { name: /Prev/ })).toBeDisabled();

    fireEvent.click(nextButton);

    await waitFor(() =>
      expect(fetchAdminAPI).toHaveBeenLastCalledWith(
        "/admin/audit/unified?limit=25&offset=25",
      ),
    );
    await screen.findByText("page.two.0");
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Prev/ })).toBeEnabled();
  });
});
