// Ward-indent pharmacy worklist (backend PR #935).
//
// Pins the page's contract with src/lib/api/wardIndents.ts: the list renders
// with filters, the detail modal offers exactly the actions the backend
// accepts from the indent's status, mutations carry expected_version plus an
// Idempotency-Key, and reason-gated actions cannot be submitted blank.

import WardIndentsPage from "@/app/(with-auth)/dashboard/ward-indents/page";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

jest.mock("@/lib/api/wardIndents", () => {
  const actual = jest.requireActual("@/lib/api/wardIndents");
  return {
    ...actual,
    listWardIndents: jest.fn(),
    getWardIndent: jest.fn(),
    reserveWardIndent: jest.fn(),
    markWardIndentShortSupply: jest.fn(),
    proposeWardIndentSubstitution: jest.fn(),
    approveWardIndentSubstitution: jest.fn(),
    rejectWardIndentSubstitution: jest.fn(),
    approveWardIndent: jest.fn(),
    rejectWardIndent: jest.fn(),
    recordWardIndentControlledHandoff: jest.fn(),
    issueWardIndent: jest.fn(),
    receiveWardIndent: jest.fn(),
    requestWardIndentReturn: jest.fn(),
    reportWardIndentDiscrepancy: jest.fn(),
    reconcileWardIndent: jest.fn(),
    cancelWardIndent: jest.fn(),
    closeWardIndent: jest.fn(),
  };
});

import {
  approveWardIndent,
  getWardIndent,
  listWardIndents,
  rejectWardIndent,
  type WardIndent,
} from "@/lib/api/wardIndents";

const listMock = listWardIndents as jest.MockedFunction<typeof listWardIndents>;
const getMock = getWardIndent as jest.MockedFunction<typeof getWardIndent>;
const approveMock = approveWardIndent as jest.MockedFunction<
  typeof approveWardIndent
>;
const rejectMock = rejectWardIndent as jest.MockedFunction<
  typeof rejectWardIndent
>;

function makeIndent(overrides: Partial<WardIndent> = {}): WardIndent {
  return {
    id: 5,
    indent_number: "WI-2026-0001",
    status: "reserved",
    state_version: 3,
    indent_type: "pharmacy",
    ward_id: 2,
    ward_name: "ICU-A",
    admission_id: 44,
    patient_uid: null,
    encounter_id: null,
    requested_by: "uid-1",
    requested_at: "2026-08-26T10:00:00.000Z",
    owner_role_codes: ["PHARMACY_STAFF", "PHARMACY_INCHARGE"],
    items: [
      {
        id: 11,
        item_name: "Paracetamol 500mg",
        pharmacy_catalog_id: 900,
        quantity_requested: 10,
        quantity_reserved: 10,
        quantity_approved: 0,
        quantity_issued: 0,
        quantity_received: 0,
        quantity_return_requested: 0,
        quantity_returned: 0,
        quantity_variance_resolved: 0,
        fulfilment_status: "reserved",
        controlled_reference_id: null,
      },
    ],
    workflow: {
      owner_role_codes: ["PHARMACY_STAFF", "PHARMACY_INCHARGE"],
      active_slas: [],
      events: [],
    },
    ...overrides,
  };
}

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue([makeIndent()]);
  getMock.mockResolvedValue(makeIndent());
});

describe("<WardIndentsPage /> list", () => {
  it("renders the worklist rows returned by the API", async () => {
    renderWithQuery(<WardIndentsPage />);

    expect(await screen.findByText("WI-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("ICU-A")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith({
      status: "",
      ward_id: "",
      overdue_only: false,
    });
  });

  it("refetches with the selected status filter", async () => {
    renderWithQuery(<WardIndentsPage />);
    await screen.findByText("WI-2026-0001");

    fireEvent.change(screen.getByTestId("ward-indent-status-filter"), {
      target: { value: "short_supply" },
    });

    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith({
        status: "short_supply",
        ward_id: "",
        overdue_only: false,
      }),
    );
  });

  it("shows the empty state when nothing matches", async () => {
    listMock.mockResolvedValue([]);
    renderWithQuery(<WardIndentsPage />);

    expect(
      await screen.findByText("No ward indents in this view."),
    ).toBeInTheDocument();
  });
});

describe("<WardIndentsPage /> detail + actions", () => {
  async function openDetail() {
    renderWithQuery(<WardIndentsPage />);
    fireEvent.click(await screen.findByText("View / act"));
    await screen.findByTestId("ward-indent-detail");
    await waitFor(() => expect(getMock).toHaveBeenCalledWith(5));
  }

  it("offers exactly the backend's actions for a reserved indent", async () => {
    await openDetail();

    // reserved → approve / short-supply / reject / cancel are legal…
    expect(
      await screen.findByTestId("ward-indent-action-approve"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("ward-indent-action-short_supply"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ward-indent-action-reject")).toBeInTheDocument();
    expect(screen.getByTestId("ward-indent-action-cancel")).toBeInTheDocument();
    // …while issue / receive / reconcile are not.
    expect(screen.queryByTestId("ward-indent-action-issue")).toBeNull();
    expect(screen.queryByTestId("ward-indent-action-receive")).toBeNull();
    expect(screen.queryByTestId("ward-indent-action-reconcile")).toBeNull();
  });

  it("submits approve with expected_version and an Idempotency-Key", async () => {
    approveMock.mockResolvedValue(makeIndent({ status: "approved" }));
    await openDetail();

    fireEvent.click(await screen.findByTestId("ward-indent-action-approve"));
    fireEvent.click(screen.getByTestId("ward-indent-action-submit"));

    await waitFor(() =>
      expect(approveMock).toHaveBeenCalledWith(
        5,
        { expected_version: 3 },
        expect.stringMatching(/^ward-indent-5:/),
      ),
    );
  });

  it("blocks reason-gated actions until a reason is entered", async () => {
    rejectMock.mockResolvedValue(makeIndent({ status: "rejected" }));
    await openDetail();

    fireEvent.click(await screen.findByTestId("ward-indent-action-reject"));
    const submit = screen.getByTestId("ward-indent-action-submit");
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Reason *"), {
      target: { value: "Duplicate indent raised by ward" },
    });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(rejectMock).toHaveBeenCalledWith(
        5,
        {
          expected_version: 3,
          reason: "Duplicate indent raised by ward",
        },
        expect.stringMatching(/^ward-indent-5:/),
      ),
    );
  });

  it("shows no actions for a terminal indent", async () => {
    getMock.mockResolvedValue(makeIndent({ status: "closed" }));
    await openDetail();

    expect(
      await screen.findByText(
        "This indent is in a terminal state — no further actions.",
      ),
    ).toBeInTheDocument();
  });
});
