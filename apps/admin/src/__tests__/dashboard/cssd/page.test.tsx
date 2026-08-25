// Re-audit lane L: the CSSD console called GET /cssd/board and nothing else,
// so instrument_sets / sterilization_loads / set_issue_log were never written
// from any client — the board was permanently empty and the theatre page's
// cssd_warnings, derived from set_issue_log, could never fire.
//
// These tests assert the write endpoints are now REACHED with the payloads
// cssdService.js expects, and that the board offers a transition control only
// where ISSUE_TRANSITIONS allows one.

import CssdPage from "@/app/(with-auth)/dashboard/cssd/page";
import { fetchAdminAPI } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
  default: { success: jest.fn(), error: jest.fn() },
}));

const api = jest.mocked(fetchAdminAPI);

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
  if (endpoint.startsWith("/theatre/today")) {
    return [
      {
        id: 12,
        procedure_name: "Laparotomy",
        ot_room: "OT-2",
        scheduled_date: "2026-08-25",
        scheduled_time: "09:00",
        status: "SCHEDULED",
      },
    ];
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

  it("issues a set against an OT case read from GET /theatre/today", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Issues" }));
    await screen.findByText("CSSDISSUE-1");

    fireEvent.click(screen.getByRole("button", { name: "Issue set" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("option", { name: /Laparotomy/ });

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
