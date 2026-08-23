
import { AuditTab } from "@/app/(with-auth)/dashboard/compliance/components/AuditTab";
import type { AuditSearchResult } from "@/app/(with-auth)/dashboard/compliance/components/types";
import { fetchAdminAPI } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn(),
}));

const mockedFetch = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;

function makeRow(overrides: Partial<AuditSearchResult> = {}): AuditSearchResult {
  return {
    id: 1,
    user_id: "42",
    user_name: "Dr Meena Iyer",
    user_role: "DOCTOR",
    ip_address: "10.0.0.7",
    method: "POST",
    path: "/api/v1/emr/clinical-notes",
    module: "emr",
    action: "create_clinical_note",
    resource: "clinical-notes",
    resource_id: "notes-901",
    request_summary: "note_type=progress",
    status_code: 201,
    response_time_ms: 45,
    success: true,
    user_agent: "jest",
    created_at: "2026-07-10T08:30:00.000Z",
    ...overrides,
  };
}

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AuditTab />
    </QueryClientProvider>,
  );
}

function runSearch() {
  fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
}

function calledParams(callIndex = 0) {
  const url = mockedFetch.mock.calls[callIndex][0] as string;
  const [pathname, qs] = url.split("?");
  return { pathname, params: new URLSearchParams(qs ?? "") };
}

describe("<AuditTab />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("searches GET /compliance/audit/search with the structured filters", async () => {
    mockedFetch.mockResolvedValue([makeRow()]);
    renderTab();

    fireEvent.change(screen.getByLabelText("Patient UID"), { target: { value: " P-100 " } });
    fireEvent.change(screen.getByLabelText("Staff UID"), { target: { value: "42" } });
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "create_clinical_note" } });
    fireEvent.change(screen.getByLabelText("Module"), { target: { value: "emr" } });
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-07-10" } });
    runSearch();

    await screen.findByText("Dr Meena Iyer");

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const { pathname, params } = calledParams();
    expect(pathname).toBe("/compliance/audit/search");
    expect(params.get("patient_uid")).toBe("P-100");
    expect(params.get("staff_uid")).toBe("42");
    expect(params.get("action")).toBe("create_clinical_note");
    expect(params.get("module")).toBe("emr");
    expect(params.get("date_from")).toBe("2026-07-01");
    expect(params.get("date_to")).toBe("2026-07-10");
    expect(params.get("page")).toBe("1");
    expect(params.get("limit")).toBe("50");
    expect(params.has("q")).toBe(false);
  });

  it("omits blank filters from the query string", async () => {
    mockedFetch.mockResolvedValue([makeRow()]);
    renderTab();

    runSearch();
    await screen.findByText("Dr Meena Iyer");

    const { pathname, params } = calledParams();
    expect(pathname).toBe("/compliance/audit/search");
    for (const key of ["patient_uid", "staff_uid", "action", "module", "date_from", "date_to"]) {
      expect(params.has(key)).toBe(false);
    }
  });

  it("renders result rows with user, action, resource, IP, and details", async () => {
    mockedFetch.mockResolvedValue([makeRow()]);
    renderTab();

    runSearch();
    await screen.findByText("Dr Meena Iyer");

    expect(screen.getByText("create_clinical_note")).toBeInTheDocument();
    expect(screen.getByText("emr")).toBeInTheDocument();
    expect(screen.getByText("DOCTOR")).toBeInTheDocument();
    expect(screen.getByText(/clinical-notes\/notes-901/)).toBeInTheDocument();
    expect(screen.getByText("10.0.0.7")).toBeInTheDocument();
    expect(screen.getByText(/note_type=progress/)).toBeInTheDocument();
  });

  it("shows the standard empty state when nothing matches", async () => {
    mockedFetch.mockResolvedValue([]);
    renderTab();

    runSearch();

    await screen.findByText("No audit entries found");
  });

  it("shows the error banner when the search fails", async () => {
    mockedFetch.mockRejectedValue(new Error("Forbidden by policy"));
    renderTab();

    runSearch();

    await screen.findByText("Forbidden by policy");
  });

  it("pages forward with the next button and disables prev on page 1", async () => {
    mockedFetch.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => makeRow({ id: i + 1 })),
    );
    renderTab();

    runSearch();
    await screen.findAllByText("Dr Meena Iyer");

    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
    const { params } = calledParams(1);
    expect(params.get("page")).toBe("2");
    expect(params.get("limit")).toBe("50");
  });
});
