// Re-audit lane L: the CSSD console called GET /cssd/board and nothing else,
// so instrument_sets / sterilization_loads / set_issue_log were never written
// from any client — the board was permanently empty and the theatre page's
// cssd_warnings, derived from set_issue_log, could never fire.
//
// These tests assert the write endpoints are now REACHED with the payloads
// cssdService.js expects, and that the board offers a transition control only
// where ISSUE_TRANSITIONS allows one.

import CssdPage from "@/app/(with-auth)/dashboard/cssd/page";
import { IssueSetDialog } from "@/app/(with-auth)/dashboard/cssd/components/IssueActions";
import { fetchAdminAPI } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));
jest.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));
jest.mock("@/contexts/TenantContext", () => ({
  useTenant: () => mockTenant,
}));
jest.mock("@/contexts/ActingTenantContext", () => ({
  useActingTenant: () => mockActing,
}));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
  default: { success: jest.fn(), error: jest.fn() },
}));

const api = jest.mocked(fetchAdminAPI);
const mockUser = { uid: "actor-a", id: 1, role: "ADMIN", permissions: [] as string[], tenantId: undefined as string | undefined };
const mockTenant = { tenant: { id: "tenant-a" } as { id: string } | null, isLoading: false };
const mockActing = {
  actingTenant: null as { id: string } | null,
  isPending: false,
  isReady: true,
  scopeKey: "confirmed-session-a" as string | null,
  isScopeCurrent: jest.fn(() => true),
};

const SET = {
  id: 5,
  set_code: "LAP-MAJOR-01",
  barcode: "CSSD-LAP-MAJOR-01",
  display_name: "Major laparotomy set",
  set_type: "instrument_set",
  specialty: "General surgery",
  storage_location: "Rack B3",
  status: "sterilized",
  usable: true,
  requires_reprocessing: false,
  last_sterilized_at: "2026-08-24T06:00:00.000Z",
};

const ISSUED = {
  id: 31,
  issue_code: "CSSDISSUE-1",
  status: "issued",
  instrument_set_id: 5,
  ot_schedule_id: 12,
  set_code: "LAP-MAJOR-01",
  set_name: "Major laparotomy set",
  procedure_name: "Laparotomy",
  ot_room: "OT-2",
  scheduled_date: "2026-08-25",
  return_due_at: "2026-08-25T16:00:00.000Z",
  issue_warning_codes: ["CSSD_SET_NOT_FROM_PASSED_LOAD"],
};

const IN_THEATRE = {
  ...ISSUED,
  id: 32,
  issue_code: "CSSDISSUE-2",
  status: "in_theatre",
};

const PLANNED_LOAD = {
  id: 71,
  load_code: "CSSDLOAD-1",
  status: "planned",
  cycle_type: "steam",
  sterilizer_name: "Autoclave 2",
  biological_indicator_result: "pending",
  chemical_indicator_result: "pending",
  mechanical_indicator_result: "pending",
  set_ids: [5],
  created_at: "2026-08-24T07:00:00.000Z",
};

const FAILED_LOAD = {
  ...PLANNED_LOAD,
  id: 72,
  load_code: "CSSDLOAD-2",
  status: "failed",
  biological_indicator_result: "failed",
};

const BOARD = {
  summary: {
    total_sets: 1,
    available_sets: 0,
    sets_in_circulation: 2,
    sets_requiring_reprocessing: 0,
    open_loads: 1,
    failed_loads: 1,
    overdue_returns: 0,
  },
  active_issues: [ISSUED, IN_THEATRE],
  recent_loads: [PLANNED_LOAD, FAILED_LOAD],
};

function routeReads(endpoint: string): unknown {
  if (endpoint.startsWith("/cssd/board")) return BOARD;
  if (endpoint.startsWith("/cssd/sets/")) {
    return {
      instrument_set_id: 5,
      set_code: "LAP-MAJOR-01",
      display_name: "Major laparotomy set",
      barcode: "CSSD-LAP-MAJOR-01",
      barcode_symbology: "code39",
      svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      generated_at: "2026-08-25T00:00:00.000Z",
    };
  }
  if (endpoint.startsWith("/cssd/sets")) return [SET];
  if (endpoint.startsWith("/cssd/loads")) return [PLANNED_LOAD, FAILED_LOAD];
  if (endpoint.startsWith("/cssd/issues")) return [ISSUED, IN_THEATRE];
  if (endpoint.startsWith("/cssd/theatre-options")) {
    return { items: [
      {
        id: 12,
        scheduled_date: new URL(endpoint, "https://example.test").searchParams.get("date"),
        scheduled_time: "09:00:00",
      },
    ], next_cursor: null };
  }
  return {};
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CssdPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.uid = "actor-a";
  mockUser.role = "ADMIN";
  mockUser.tenantId = undefined;
  mockTenant.tenant = { id: "tenant-a" };
  mockTenant.isLoading = false;
  mockActing.actingTenant = null;
  mockActing.isPending = false;
  mockActing.isReady = true;
  mockActing.scopeKey = "confirmed-session-a";
  mockActing.isScopeCurrent.mockReturnValue(true);
  api.mockImplementation(
    async (endpoint: string, init?: { method?: string }) =>
      init?.method ? {} : routeReads(endpoint),
  );
});

describe("<CssdPage /> board", () => {
  it("offers exactly the transitions ISSUE_TRANSITIONS allows for each issue", async () => {
    renderPage();
    const issuedRow = (await screen.findByText("CSSDISSUE-1")).closest("tr");
    // issued → ['in_theatre', 'returned', 'cancelled']
    expect(
      within(issuedRow!).getByRole("button", { name: "Mark in theatre" }),
    ).toBeInTheDocument();
    expect(
      within(issuedRow!).getByRole("button", { name: "Record return" }),
    ).toBeInTheDocument();
    expect(
      within(issuedRow!).getByRole("button", { name: "Cancel issue" }),
    ).toBeInTheDocument();
    expect(
      within(issuedRow!).queryByRole("button", { name: "Mark decontaminated" }),
    ).toBeNull();

    // in_theatre → ['returned'] only.
    const theatreRow = screen.getByText("CSSDISSUE-2").closest("tr");
    expect(
      within(theatreRow!).getByRole("button", { name: "Record return" }),
    ).toBeInTheDocument();
    expect(within(theatreRow!).queryAllByRole("button")).toHaveLength(1);
  });

  it("moves an issue to theatre through POST /cssd/issues/{id}/theatre-use", async () => {
    renderPage();
    const issuedRow = (await screen.findByText("CSSDISSUE-1")).closest("tr");
    fireEvent.click(
      within(issuedRow!).getByRole("button", { name: "Mark in theatre" }),
    );

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Mark in theatre" }),
    );

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/cssd/issues/31/theatre-use", {
        method: "POST",
        body: {},
      }),
    );
  });

  it("sends the chosen return condition on POST /cssd/issues/{id}/return", async () => {
    renderPage();
    const issuedRow = (await screen.findByText("CSSDISSUE-1")).closest("tr");
    fireEvent.click(
      within(issuedRow!).getByRole("button", { name: "Record return" }),
    );

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Return condition"), {
      target: { value: "damaged" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Record return" }),
    );

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/cssd/issues/31/return", {
        method: "POST",
        body: { return_condition: "damaged" },
      }),
    );
  });

  it("offers a load update only while the load is still open", async () => {
    renderPage();
    const plannedRow = (await screen.findByText("CSSDLOAD-1")).closest("tr");
    expect(
      within(plannedRow!).getByRole("button", { name: "Update" }),
    ).toBeInTheDocument();

    const failedRow = screen.getByText("CSSDLOAD-2").closest("tr");
    expect(
      within(failedRow!).queryByRole("button", { name: "Update" }),
    ).toBeNull();
  });
});

describe("<CssdPage /> sets", () => {
  it("creates an instrument set through POST /cssd/sets", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Sets" }));
    await screen.findByText("LAP-MAJOR-01");

    fireEvent.click(screen.getByRole("button", { name: "New set" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Display name"), {
      target: { value: "Minor set" },
    });
    fireEvent.change(within(dialog).getByLabelText("Instrument name 1"), {
      target: { value: "Mosquito forceps" },
    });
    fireEvent.change(within(dialog).getByLabelText("Instrument quantity 1"), {
      target: { value: "2" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create set" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/cssd/sets", {
        method: "POST",
        body: {
          set_code: undefined,
          display_name: "Minor set",
          set_type: "instrument_set",
          specialty: undefined,
          storage_location: undefined,
          contents: [
            { name: "Mosquito forceps", quantity: 2, critical: false },
          ],
          notes: undefined,
        },
      }),
    );
  });

  it("fetches the printable label from GET /cssd/sets/{id}/label", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Sets" }));
    fireEvent.click(await screen.findByRole("button", { name: "Print label" }));

    await waitFor(() => expect(api).toHaveBeenCalledWith("/cssd/sets/5/label"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByAltText("Code 39 barcode for CSSD-LAP-MAJOR-01"),
    ).toBeInTheDocument();
  });
});

describe("<CssdPage /> loads and issues", () => {
  it("records a sterilization load through POST /cssd/loads", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Loads" }));
    await screen.findByText("CSSDLOAD-1");

    fireEvent.click(screen.getByRole("button", { name: "New load" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByLabelText("Include LAP-MAJOR-01 in this load"),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Record load" }),
    );

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/cssd/loads", {
        method: "POST",
        body: {
          set_ids: [5],
          cycle_type: "steam",
          sterilizer_name: undefined,
          started_at: undefined,
          completed_at: undefined,
          biological_indicator_result: "pending",
          chemical_indicator_result: "pending",
          mechanical_indicator_result: "pending",
          failure_reason: undefined,
          notes: undefined,
        },
      }),
    );
  });

  it("issues a set against a case read from the minimal CSSD directory", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Issues" }));
    await screen.findByText("CSSDISSUE-1");

    fireEvent.click(screen.getByRole("button", { name: "Issue set" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("option", { name: "Case #12 · 09:00:00" });

    fireEvent.change(within(dialog).getByLabelText("Instrument set"), {
      target: { value: "5" },
    });
    fireEvent.change(within(dialog).getByLabelText("OT case"), {
      target: { value: "12" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Issue set" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/cssd/issues", {
        method: "POST",
        body: {
          instrument_set_id: 5,
          ot_schedule_id: 12,
          return_due_at: undefined,
          notes: undefined,
        },
      }),
    );
  });
});

describe("CSSD minimal case directory", () => {
  function renderDialog() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const close = jest.fn();
    const ui = () => <QueryClientProvider client={qc}><IssueSetDialog presetSetId={5} onClose={close} /></QueryClientProvider>;
    const view = render(ui());
    return { qc, close, rerender: () => view.rerender(ui()) };
  }

  it("shows case number/time only and loads later pages", async () => {
    mockUser.role = "QUALITY_OFFICER";
    api.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith("/cssd/theatre-options")) {
        const query = new URL(endpoint, "https://example.test").searchParams;
        return {
          items: [{ id: query.has("cursor") ? 13 : 12, scheduled_date: query.get("date"), scheduled_time: null }],
          next_cursor: query.has("cursor") ? null : "next-page",
        };
      }
      return routeReads(endpoint);
    });
    renderDialog();
    await screen.findByRole("option", { name: "Case #12 · Time not scheduled" });
    fireEvent.click(screen.getByRole("button", { name: "Load more cases" }));
    await screen.findByRole("option", { name: "Case #13 · Time not scheduled" });
    expect(api.mock.calls.some(([path]) => path.startsWith("/theatre/today"))).toBe(false);
    expect(screen.queryByRole("option", { name: /Laparotomy|OT-2/ })).toBeNull();
  });

  it("clears the case on a date change while preserving the independent set selection", async () => {
    renderDialog();
    await screen.findByRole("option", { name: "Case #12 · 09:00:00" });
    fireEvent.change(screen.getByLabelText("OT case"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Theatre date"), { target: { value: "2001-01-02" } });
    expect(screen.getByLabelText("OT case")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Issue set" })).toBeDisabled();
    await screen.findByRole("option", { name: "Case #12 · 09:00:00" });
    expect(screen.getByLabelText("OT case")).toHaveValue("");
  });

  it.each(["COMPLIANCE_OFFICER", "DATA_PROTECTION_OFFICER", "HR_STAFF", "PHARMACY_INCHARGE", "STORES_PURCHASE_INCHARGE"])(
    "surfaces the lookup denial for %s without a theatre fallback", async role => {
      mockUser.role = role;
      api.mockImplementation(async (endpoint: string) => {
        if (endpoint.startsWith("/cssd/theatre-options")) throw new Error("Forbidden");
        return routeReads(endpoint);
      });
      renderDialog();
      await screen.findByText(/Case directory unavailable — Forbidden/);
      expect(screen.getByRole("button", { name: "Issue set" })).toBeDisabled();
      expect(api.mock.calls.some(([path]) => path.startsWith("/theatre/"))).toBe(false);
    },
  );

  it("rejects extra clinical fields and does not cache the broad record", async () => {
    api.mockImplementation(async (endpoint: string) => {
      const result = routeReads(endpoint);
      if (!endpoint.startsWith("/cssd/theatre-options")) return result;
      const page = result as { items: object[]; next_cursor: null };
      return { ...page, items: page.items.map(item => ({ ...item, procedure_name: "sensitive-canary" })) };
    });
    const { qc } = renderDialog();
    await screen.findByText(/Could not read the case directory/);
    expect(screen.queryByRole("option", { name: /Case #12/ })).toBeNull();
    expect(JSON.stringify(qc.getQueryCache().getAll().map(query => query.state.data))).not.toContain("sensitive-canary");
  });

  it("distinguishes an unavailable directory from an authorized empty result", async () => {
    api.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith("/cssd/theatre-options")) throw new Error("Lookup temporarily unavailable");
      return routeReads(endpoint);
    });
    renderDialog();
    await screen.findByText(/Lookup temporarily unavailable/);
    expect(screen.queryByText("No eligible OT case on this date")).toBeNull();
    expect(screen.getByRole("button", { name: "Issue set" })).toBeDisabled();
  });

  it("requires a new selection when the case time changes during revalidation", async () => {
    let reads = 0;
    api.mockImplementation(async (endpoint: string, init?: { method?: string }) => {
      const result = routeReads(endpoint);
      if (endpoint.startsWith("/cssd/theatre-options") && ++reads > 1) {
        const page = result as { items: object[]; next_cursor: null };
        return { ...page, items: page.items.map(item => ({ ...item, scheduled_time: "10:00:00" })) };
      }
      return init?.method ? {} : result;
    });
    renderDialog();
    await screen.findByRole("option", { name: "Case #12 · 09:00:00" });
    await screen.findByRole("option", { name: /Major laparotomy set/ });
    fireEvent.change(screen.getByLabelText("OT case"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Issue set" }));
    await screen.findByText(/case selection is no longer available/);
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("refuses an issue when the selected case is absent on revalidation", async () => {
    let reads = 0;
    api.mockImplementation(async (endpoint: string, init?: { method?: string }) => {
      if (endpoint.startsWith("/cssd/theatre-options") && ++reads > 1) return { items: [], next_cursor: null };
      return init?.method ? {} : routeReads(endpoint);
    });
    renderDialog();
    await screen.findByRole("option", { name: "Case #12 · 09:00:00" });
    await screen.findByRole("option", { name: /Major laparotomy set/ });
    fireEvent.change(screen.getByLabelText("OT case"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Issue set" }));
    await screen.findByText(/case selection is no longer available/);
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(screen.getByLabelText("OT case")).toHaveValue("");
  });

  it.each(["tenant", "actor"])("discards the case and preset set on a %s change", async changedScope => {
    const view = renderDialog();
    await screen.findByRole("option", { name: "Case #12 · 09:00:00" });
    fireEvent.change(screen.getByLabelText("OT case"), { target: { value: "12" } });
    if (changedScope === "tenant") mockTenant.tenant = { id: "tenant-b" };
    else mockUser.uid = "actor-b";
    view.rerender();
    expect(screen.queryByLabelText("Instrument set")).toBeNull();
    expect(screen.queryByRole("option", { name: /Case #12/ })).toBeNull();
    await waitFor(() => expect(view.close).toHaveBeenCalled());
  });

  it("ignores a late result from the previous date", async () => {
    let resolveLookup!: (value: unknown) => void;
    let oldDate = "";
    api.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith("/cssd/theatre-options")) {
        const date = new URL(endpoint, "https://example.test").searchParams.get("date")!;
        if (date === "2001-01-02") return { items: [], next_cursor: null };
        oldDate = date;
        return new Promise(resolve => { resolveLookup = resolve; });
      }
      return routeReads(endpoint);
    });
    renderDialog();
    await waitFor(() => expect(resolveLookup).toBeDefined());
    fireEvent.change(screen.getByLabelText("Theatre date"), { target: { value: "2001-01-02" } });
    await act(async () => resolveLookup({ items: [{ id: 99, scheduled_date: oldDate, scheduled_time: "09:00:00" }], next_cursor: null }));
    expect(screen.queryByRole("option", { name: /Case #99/ })).toBeNull();
  });

  it("includes the staff profile tenant in scope independently of tenant branding", async () => {
    mockUser.role = "INFECTION_CONTROL_OFFICER";
    mockUser.tenantId = "tenant-a";
    mockTenant.tenant = null;
    const view = renderDialog();
    await screen.findByRole("option", { name: "Case #12 · 09:00:00" });
    mockUser.tenantId = "tenant-b";
    view.rerender();
    expect(screen.queryByLabelText("OT case")).toBeNull();
    await waitFor(() => expect(view.close).toHaveBeenCalled());
  });

  it("discards selections when confirmed scope readiness is lost", async () => {
    const view = renderDialog();
    await screen.findByRole("option", { name: "Case #12 · 09:00:00" });
    mockActing.isReady = false;
    mockActing.scopeKey = null;
    mockActing.isScopeCurrent.mockReturnValue(false);
    view.rerender();
    expect(screen.queryByLabelText("OT case")).toBeNull();
    await waitFor(() => expect(view.close).toHaveBeenCalled());
  });

  it("supports a confirmed staff session without ADMIN-only tenant branding", async () => {
    mockUser.role = "INFECTION_CONTROL_OFFICER";
    mockTenant.tenant = null;
    mockTenant.isLoading = true;
    const view = renderDialog();
    await screen.findByRole("option", { name: "Case #12 · 09:00:00" });
    fireEvent.change(screen.getByLabelText("OT case"), { target: { value: "12" } });
    mockActing.scopeKey = "confirmed-session-b";
    view.rerender();
    expect(screen.queryByLabelText("Instrument set")).toBeNull();
    await waitFor(() => expect(view.close).toHaveBeenCalled());
  });

  it("suppresses case requests until the session scope is confirmed", () => {
    mockActing.isReady = false;
    mockActing.scopeKey = null;
    renderDialog();
    expect(api.mock.calls.some(([path]) => path.startsWith("/cssd/theatre-options"))).toBe(false);
    expect(screen.getByRole("button", { name: "Issue set" })).toBeDisabled();
  });
});
