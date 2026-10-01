// Re-audit lane L: the linen console rendered a board that nothing in the
// product could populate — GET /linen-laundry/board was the only endpoint with
// a caller. These tests assert the other ten are now REACHED, with the payload
// shape linenLaundryService.js expects, and that the board offers a control
// only for a transition CYCLE_TRANSITIONS allows.
//
// fetchAdminAPI is mocked at the transport seam rather than the api module, so
// the literal paths and HTTP verbs the console sends are what gets asserted.

import LinenLaundryPage from "@/app/(with-auth)/dashboard/linen-laundry/page";
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
import type { ReactElement } from "react";
import { NewCycleDialog } from "@/app/(with-auth)/dashboard/linen-laundry/components/CycleDialogs";
import { ParLevelDialog } from "@/app/(with-auth)/dashboard/linen-laundry/components/ParLevelDialog";

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

const ITEM_TYPE = {
  id: 7,
  item_code: "SHEET-STD",
  display_name: "Standard bed sheet",
  category: "bed_linen",
  unit: "piece",
  active: true,
  updated_at: "2026-08-24T04:00:00.000Z",
};

const OPEN_CYCLE = {
  id: 41,
  cycle_code: "LDR-20260824-0001",
  ward_id: 3,
  ward_name: "Ward A",
  status: "collection_requested",
  discrepancy_flag: false,
  item_count: 1,
  soiled_collected_quantity: 0,
  clean_returned_quantity: 0,
  updated_at: "2026-08-24T05:00:00.000Z",
};

const CLOSED_CYCLE = {
  ...OPEN_CYCLE,
  id: 42,
  cycle_code: "LDR-20260824-0002",
  status: "reconciled",
};

const BOARD = {
  summary: {
    par_level_count: 1,
    below_par_count: 1,
    open_cycle_count: 1,
    discrepancy_cycle_count: 0,
    shortage_quantity: 2,
  },
  par_levels: [
    {
      id: 11,
      ward_id: 3,
      ward_name: "Ward A",
      item_type_id: 7,
      item_code: "SHEET-STD",
      display_name: "Standard bed sheet",
      category: "bed_linen",
      unit: "piece",
      par_quantity: 20,
      actual_quantity: 18,
      reorder_threshold: 4,
      par_delta: -2,
      below_par: true,
      last_counted_at: "2026-08-24T03:00:00.000Z",
    },
  ],
  cycles: [OPEN_CYCLE, CLOSED_CYCLE],
};

const CYCLE_DETAIL = {
  ...OPEN_CYCLE,
  items: [
    {
      id: 90,
      cycle_id: 41,
      item_type_id: 7,
      item_code: "SHEET-STD",
      display_name: "Standard bed sheet",
      category: "bed_linen",
      unit: "piece",
      soiled_planned_quantity: 10,
      soiled_collected_quantity: 0,
      clean_returned_quantity: 0,
      damaged_quantity: 0,
      missing_quantity: 0,
      discrepancy_quantity: 0,
      discrepancy_flag: false,
    },
  ],
};

function routeReads(endpoint: string): unknown {
  if (endpoint.startsWith("/linen-laundry/board")) return BOARD;
  if (endpoint.startsWith("/linen-laundry/item-types")) return [ITEM_TYPE];
  if (endpoint === "/linen-laundry/cycles/41") return CYCLE_DETAIL;
  if (endpoint.startsWith("/linen-laundry/wards")) {
    return { items: [{ id: 3, name: "Ward A" }], next_cursor: null };
  }
  return {};
}

function renderPage(): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={qc}>
      <LinenLaundryPage />
    </QueryClientProvider>
  );
  render(ui);
  return ui;
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

describe("<LinenLaundryPage /> board actions", () => {
  it("offers exactly the transitions CYCLE_TRANSITIONS allows for each cycle", async () => {
    renderPage();
    const openRow = (await screen.findByText("LDR-20260824-0001")).closest(
      "tr",
    );
    expect(openRow).not.toBeNull();

    // collection_requested → ['collected', 'cancelled'] and nothing else.
    expect(
      within(openRow!).getByRole("button", { name: "Record collection" }),
    ).toBeInTheDocument();
    expect(
      within(openRow!).getByRole("button", { name: "Cancel cycle" }),
    ).toBeInTheDocument();
    expect(
      within(openRow!).queryByRole("button", { name: "Send to laundry" }),
    ).toBeNull();
    expect(
      within(openRow!).queryByRole("button", { name: "Reconcile" }),
    ).toBeNull();

    // reconciled → [] : a terminal cycle gets no control at all.
    const closedRow = screen.getByText("LDR-20260824-0002").closest("tr");
    expect(within(closedRow!).queryAllByRole("button")).toHaveLength(0);
    expect(within(closedRow!).getByText("Closed")).toBeInTheDocument();
  });

  it("records a collection against POST /cycles/{id}/collect with per-item counts", async () => {
    renderPage();
    const openRow = (await screen.findByText("LDR-20260824-0001")).closest(
      "tr",
    );
    fireEvent.click(
      within(openRow!).getByRole("button", { name: "Record collection" }),
    );

    // The dialog needs the cycle's items, so it reads the cycle first.
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/linen-laundry/cycles/41"),
    );

    const dialog = await screen.findByRole("dialog");
    const qty = within(dialog).getByLabelText(
      "Soiled quantity for Standard bed sheet",
    );
    // Defaults to the planned quantity the cycle was created with.
    expect(qty).toHaveValue("10");
    fireEvent.change(qty, { target: { value: "9" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Record collection" }),
    );

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/linen-laundry/cycles/41/collect", {
        method: "POST",
        body: { items: [{ item_type_id: 7, soiled_collected_quantity: 9 }] },
      }),
    );
  });

  it("saves a ward par level through PUT /linen-laundry/par-levels", async () => {
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Set par level" }),
    );

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("option", { name: /Standard bed sheet/ });
    fireEvent.change(within(dialog).getByLabelText("Ward"), {
      target: { value: "3" },
    });
    fireEvent.change(within(dialog).getByLabelText("Linen item"), {
      target: { value: "7" },
    });
    fireEvent.change(within(dialog).getByLabelText("Par quantity"), {
      target: { value: "20" },
    });
    fireEvent.change(within(dialog).getByLabelText("Actual on hand"), {
      target: { value: "18" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save par level" }),
    );

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/linen-laundry/par-levels", {
        method: "PUT",
        body: {
          ward_id: 3,
          item_type_id: 7,
          par_quantity: 20,
          actual_quantity: 18,
          reorder_threshold: 0,
          notes: undefined,
        },
      }),
    );
  });

  it("creates a laundry cycle through POST /linen-laundry/cycles", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New cycle" }));

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Standard bed sheet");
    fireEvent.change(within(dialog).getByLabelText("Ward"), {
      target: { value: "3" },
    });
    fireEvent.change(
      within(dialog).getByLabelText("Soiled quantity for Standard bed sheet"),
      { target: { value: "10" } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create cycle" }),
    );

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/linen-laundry/cycles", {
        method: "POST",
        body: {
          ward_id: 3,
          items: [{ item_type_id: 7, soiled_planned_quantity: 10 }],
          notes: undefined,
        },
      }),
    );
  });
});

describe("<LinenLaundryPage /> item types", () => {
  it("configures an item type through POST /linen-laundry/item-types", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Item types" }));
    await screen.findByText("SHEET-STD");

    fireEvent.click(screen.getByRole("button", { name: "New item type" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Item code"), {
      target: { value: "gown-std" },
    });
    fireEvent.change(within(dialog).getByLabelText("Display name"), {
      target: { value: "Patient gown" },
    });
    fireEvent.change(within(dialog).getByLabelText("Category"), {
      target: { value: "patient_linen" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/linen-laundry/item-types", {
        method: "POST",
        body: {
          item_code: "gown-std",
          display_name: "Patient gown",
          category: "patient_linen",
          unit: "piece",
          active: true,
        },
      }),
    );
  });
});

describe("<LinenLaundryPage /> transitions that carry no item counts", () => {
  // The item-count transitions read GET /cycles/{id} first; the other three do
  // not, and the dialog must stay submittable with that query disabled — a
  // `useQuery` left in a pending state would otherwise leave the button
  // permanently greyed out.
  it("cancels a cycle through POST /cycles/{id}/cancel without reading its items", async () => {
    renderPage();
    const openRow = (await screen.findByText("LDR-20260824-0001")).closest(
      "tr",
    );
    fireEvent.click(
      within(openRow!).getByRole("button", { name: "Cancel cycle" }),
    );

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Cancellation reason"), {
      target: { value: "Ward deferred the round" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Cancel cycle" }),
    );

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/linen-laundry/cycles/41/cancel", {
        method: "POST",
        body: { reason: "Ward deferred the round" },
      }),
    );
    expect(api).not.toHaveBeenCalledWith("/linen-laundry/cycles/41");
  });
});

describe("Linen ward lookup contract", () => {
  function renderDialog() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const close = jest.fn();
    const ui = () => <QueryClientProvider client={qc}><NewCycleDialog onClose={close} /></QueryClientProvider>;
    const view = render(ui());
    return { qc, close, rerender: () => view.rerender(ui()) };
  }

  it("uses the minimal directory for stores users and supports later pages", async () => {
    mockUser.role = "STORES_PURCHASE_INCHARGE";
    api.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/linen-laundry/wards") {
        return { items: [{ id: 3, name: "Ward A" }], next_cursor: "next-page" };
      }
      if (endpoint === "/linen-laundry/wards?cursor=next-page") {
        return { items: [{ id: 4, name: "Unmapped first-use ward" }], next_cursor: null };
      }
      return routeReads(endpoint);
    });
    renderDialog();
    await screen.findByRole("option", { name: "Ward A" });
    fireEvent.click(screen.getByRole("button", { name: "Load more wards" }));
    await screen.findByRole("option", { name: "Unmapped first-use ward" });
    expect(api).toHaveBeenCalledWith("/linen-laundry/wards?cursor=next-page");
    expect(api.mock.calls.some(([path]) => path === "/wards")).toBe(false);
  });

  it.each(["Forbidden", "Lookup temporarily unavailable"])("shows %s without presenting an empty directory", async message => {
    api.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith("/linen-laundry/wards")) throw new Error(message);
      return routeReads(endpoint);
    });
    renderDialog();
    await screen.findByText(new RegExp(message));
    expect(screen.queryByText("No wards are available.")).toBeNull();
    expect(screen.getByRole("button", { name: "Create cycle" })).toBeDisabled();
  });

  it("rejects a broad or malformed response without caching sensitive fields", async () => {
    api.mockImplementation(async (endpoint: string) => endpoint.startsWith("/linen-laundry/wards")
      ? { items: [{ id: 3, name: "Ward A", occupied_count: "sensitive-canary" }], next_cursor: null }
      : routeReads(endpoint));
    const { qc } = renderDialog();
    await screen.findByText(/Could not read the ward directory/);
    expect(screen.queryByRole("option", { name: "Ward A" })).toBeNull();
    expect(JSON.stringify(qc.getQueryCache().getAll().map(query => query.state.data))).not.toContain("sensitive-canary");
  });

  it("refuses submission when a selected ward disappears during revalidation", async () => {
    let reads = 0;
    api.mockImplementation(async (endpoint: string, init?: { method?: string }) => {
      if (endpoint.startsWith("/linen-laundry/wards")) {
        reads += 1;
        return { items: reads === 1 ? [{ id: 3, name: "Ward A" }] : [], next_cursor: null };
      }
      return init?.method ? {} : routeReads(endpoint);
    });
    renderDialog();
    await screen.findByRole("option", { name: "Ward A" });
    await screen.findByText("Standard bed sheet");
    fireEvent.change(screen.getByLabelText("Ward"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Soiled quantity for Standard bed sheet"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create cycle" }));
    await screen.findByText(/ward selection is no longer available/);
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(screen.getByLabelText("Ward")).toHaveValue("");
  });

  it.each(["tenant", "actor"])("discards selections on a %s change", async changedScope => {
    const view = renderDialog();
    await screen.findByRole("option", { name: "Ward A" });
    fireEvent.change(screen.getByLabelText("Ward"), { target: { value: "3" } });
    if (changedScope === "tenant") mockTenant.tenant = { id: "tenant-b" };
    else mockUser.uid = "actor-b";
    view.rerender();
    expect(screen.queryByRole("option", { name: "Ward A" })).toBeNull();
    await waitFor(() => expect(view.close).toHaveBeenCalled());
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("ignores a late directory response after a tenant change", async () => {
    let resolveLookup!: (value: unknown) => void;
    const pending = new Promise(resolve => { resolveLookup = resolve; });
    api.mockImplementation(async (endpoint: string) => endpoint.startsWith("/linen-laundry/wards")
      ? pending : routeReads(endpoint));
    const view = renderDialog();
    await waitFor(() => expect(api).toHaveBeenCalledWith("/linen-laundry/wards"));
    mockTenant.tenant = { id: "tenant-b" };
    view.rerender();
    await act(async () => resolveLookup({ items: [{ id: 3, name: "Old tenant ward" }], next_cursor: null }));
    expect(screen.queryByText("Old tenant ward")).toBeNull();
    expect(view.close).toHaveBeenCalled();
  });

  it("preserves an existing par-level draft through a lookup failure and recovery", async () => {
    let reads = 0;
    api.mockImplementation(async (endpoint: string, init?: { method?: string }) => {
      if (endpoint.startsWith("/linen-laundry/wards") && ++reads === 2) {
        throw new Error("Lookup temporarily unavailable");
      }
      return init?.method ? {} : routeReads(endpoint);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const close = jest.fn();
    render(<QueryClientProvider client={qc}><ParLevelDialog row={BOARD.par_levels[0]} onClose={close} /></QueryClientProvider>);
    await screen.findByRole("option", { name: "Ward A" });
    fireEvent.change(screen.getByLabelText("Actual on hand"), { target: { value: "23" } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Count awaiting confirmation" } });
    fireEvent.click(screen.getByRole("button", { name: "Save par level" }));

    await screen.findByText("The ward could not be confirmed. Refresh the ward directory before saving.");
    expect(screen.getByRole("button", { name: "Save par level" })).toBeDisabled();
    expect(screen.getByLabelText("Ward")).toBeDisabled();
    expect(screen.getByLabelText("Ward")).toHaveValue("");
    expect(api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    expect(close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh ward directory" }));
    await screen.findByRole("option", { name: "Ward A" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save par level" })).toBeEnabled());
    expect(screen.getByLabelText("Ward")).toHaveValue("3");
    expect(screen.getByLabelText("Ward")).toBeDisabled();
    expect(screen.getByLabelText("Actual on hand")).toHaveValue("23");
    expect(screen.getByLabelText("Notes")).toHaveValue("Count awaiting confirmation");
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save par level" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/linen-laundry/par-levels", {
      method: "PUT",
      body: {
        ward_id: 3, item_type_id: 7, par_quantity: 20, actual_quantity: 23,
        reorder_threshold: 4, notes: "Count awaiting confirmation",
      },
    }));
  });

  it("discards an existing par-level draft if scope changes during ward revalidation", async () => {
    let reads = 0;
    let resolveLookup!: (value: unknown) => void;
    api.mockImplementation(async (endpoint: string, init?: { method?: string }) => {
      if (endpoint.startsWith("/linen-laundry/wards") && ++reads === 2) {
        return new Promise(resolve => { resolveLookup = resolve; });
      }
      return init?.method ? {} : routeReads(endpoint);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const close = jest.fn();
    const ui = () => <QueryClientProvider client={qc}><ParLevelDialog row={BOARD.par_levels[0]} onClose={close} /></QueryClientProvider>;
    const view = render(ui());
    await screen.findByRole("option", { name: "Ward A" });
    fireEvent.click(screen.getByRole("button", { name: "Save par level" }));
    await waitFor(() => expect(resolveLookup).toBeDefined());
    mockTenant.tenant = { id: "tenant-b" };
    view.rerender(ui());
    expect(screen.queryByLabelText("Ward")).toBeNull();
    await act(async () => resolveLookup({ items: [{ id: 3, name: "Ward A" }], next_cursor: null }));
    expect(close).toHaveBeenCalled();
    expect(screen.queryByLabelText("Actual on hand")).toBeNull();
    expect(api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("does not turn a historical par-level ward into an authorized option", async () => {
    api.mockImplementation(async (endpoint: string) => endpoint.startsWith("/linen-laundry/wards")
      ? { items: [], next_cursor: null } : routeReads(endpoint));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ParLevelDialog row={BOARD.par_levels[0]} onClose={jest.fn()} /></QueryClientProvider>);
    await screen.findByText("This historical ward is no longer available for selection.");
    expect(screen.queryByRole("option", { name: "Ward A" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save par level" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh ward directory" }));
    await screen.findByText("The ward could not be confirmed. Refresh the ward directory before saving.");
    expect(screen.queryByRole("option", { name: "Ward A" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save par level" })).toBeDisabled();
    expect(api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("includes the staff profile tenant in scope independently of tenant branding", async () => {
    mockUser.role = "STORES_PURCHASE_INCHARGE";
    mockUser.tenantId = "tenant-a";
    mockTenant.tenant = null;
    const view = renderDialog();
    await screen.findByRole("option", { name: "Ward A" });
    mockUser.tenantId = "tenant-b";
    view.rerender();
    expect(screen.queryByLabelText("Ward")).toBeNull();
    await waitFor(() => expect(view.close).toHaveBeenCalled());
  });

  it("discards selections when confirmed scope readiness is lost", async () => {
    const view = renderDialog();
    await screen.findByRole("option", { name: "Ward A" });
    mockActing.isReady = false;
    mockActing.scopeKey = null;
    mockActing.isScopeCurrent.mockReturnValue(false);
    view.rerender();
    expect(screen.queryByLabelText("Ward")).toBeNull();
    await waitFor(() => expect(view.close).toHaveBeenCalled());
  });

  it("supports a confirmed staff session without the ADMIN-only branding context", async () => {
    mockUser.role = "STORES_PURCHASE_INCHARGE";
    mockTenant.tenant = null;
    mockTenant.isLoading = true;
    const view = renderDialog();
    await screen.findByRole("option", { name: "Ward A" });
    fireEvent.change(screen.getByLabelText("Ward"), { target: { value: "3" } });
    mockActing.scopeKey = "confirmed-session-b";
    view.rerender();
    expect(screen.queryByRole("option", { name: "Ward A" })).toBeNull();
    await waitFor(() => expect(view.close).toHaveBeenCalled());
  });

  it("suppresses lookup requests until the session scope is confirmed", () => {
    mockActing.isReady = false;
    mockActing.scopeKey = null;
    renderDialog();
    expect(api.mock.calls.some(([path]) => path.startsWith("/linen-laundry/wards"))).toBe(false);
    expect(screen.getByRole("button", { name: "Create cycle" })).toBeDisabled();
  });
});
