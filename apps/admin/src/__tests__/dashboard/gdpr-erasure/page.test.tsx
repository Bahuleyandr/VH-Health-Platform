import GdprErasurePage from "@/app/(with-auth)/dashboard/gdpr-erasure/page";
import { APIError } from "@/lib/api/core";
import {
  executeErasure,
  getErasureLog,
  LEGAL_HOLD_ACTIVE,
  type ErasureLogRow,
} from "@/lib/api/gdprErasure";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/gdprErasure", () => {
  const actual = jest.requireActual("@/lib/api/gdprErasure");
  return {
    ...actual,
    getErasureLog: jest.fn(),
    executeErasure: jest.fn(),
  };
});

const mockGetLog = getErasureLog as jest.MockedFunction<typeof getErasureLog>;
const mockExecute = executeErasure as jest.MockedFunction<
  typeof executeErasure
>;

const logRow: ErasureLogRow = {
  id: 9,
  uid: "22222222-2222-4222-8222-222222222222",
  phone_hash: null,
  requested_by: "admin-uid-1",
  reason: "DPDP erasure request ref #42",
  tables_processed: 12,
  completed_at: "2026-08-10T12:00:05.000Z",
  duration_ms: 5120,
  created_at: "2026-08-10T12:00:00.000Z",
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GdprErasurePage />
    </QueryClientProvider>,
  );
}

/** Fill subject + reason and open the confirmation step. */
async function startErasure(uid: string, reason: string) {
  fireEvent.change(screen.getByLabelText("Subject UID"), {
    target: { value: uid },
  });
  fireEvent.change(screen.getByLabelText(/Reason \(required/), {
    target: { value: reason },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Continue to confirmation" }),
  );
  return screen.getByRole("button", { name: "Erase permanently" });
}

describe("<GdprErasurePage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLog.mockResolvedValue([logRow]);
  });

  it("renders the erasure log with who/when/subject/reason", async () => {
    renderPage();

    expect(
      await screen.findByText("DPDP erasure request ref #42"),
    ).toBeInTheDocument();
    expect(screen.getByText("admin-uid-1")).toBeInTheDocument();
    expect(
      screen.getByText("22222222-2222-4222-8222-222222222222"),
    ).toBeInTheDocument();
    expect(mockGetLog).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  it("requires the typed ERASE confirmation before executing", async () => {
    mockExecute.mockResolvedValue({
      success: true,
      uid: "u-1",
      erasedAt: "2026-08-23T08:00:00.000Z",
      duration_ms: 900,
      tables: { users: { action: "anonymized", count: 1 } },
    });
    renderPage();
    await screen.findByText("DPDP erasure request ref #42");

    const executeButton = await startErasure("u-1", "GDPR request #7");

    // Confirmation step is up, but nothing has run and the destructive
    // button stays disabled until the exact word is typed.
    expect(mockExecute).not.toHaveBeenCalled();
    expect(executeButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Type ERASE to confirm"), {
      target: { value: "erase" },
    });
    expect(executeButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Type ERASE to confirm"), {
      target: { value: "ERASE" },
    });
    expect(executeButton).toBeEnabled();
    fireEvent.click(executeButton);

    await waitFor(() =>
      expect(mockExecute).toHaveBeenCalledWith({
        uid: "u-1",
        reason: "GDPR request #7",
      }),
    );
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Erasure completed")).toBeInTheDocument();
    expect(screen.getByText(/users: anonymized \(1\)/)).toBeInTheDocument();
  });

  it("keeps Continue disabled without a subject or reason", async () => {
    renderPage();
    await screen.findByText("DPDP erasure request ref #42");

    const continueButton = screen.getByRole("button", {
      name: "Continue to confirmation",
    });
    expect(continueButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Subject UID"), {
      target: { value: "u-1" },
    });
    expect(continueButton).toBeDisabled(); // reason still missing

    fireEvent.change(screen.getByLabelText(/Reason \(required/), {
      target: { value: "ref #1" },
    });
    expect(continueButton).toBeEnabled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("surfaces a legal-hold refusal verbatim", async () => {
    mockExecute.mockRejectedValue(
      new APIError("Forbidden", 403, {
        success: false,
        message: "Cannot erase: user has an active legal hold",
        requestId: "req-hold-1",
        details: { code: LEGAL_HOLD_ACTIVE },
      }),
    );
    renderPage();
    await screen.findByText("DPDP erasure request ref #42");

    const executeButton = await startErasure("u-held", "GDPR request #8");
    fireEvent.change(screen.getByLabelText("Type ERASE to confirm"), {
      target: { value: "ERASE" },
    });
    fireEvent.click(executeButton);

    expect(
      await screen.findByText("Blocked by legal hold"),
    ).toBeInTheDocument();
    // The backend's message, verbatim.
    expect(
      screen.getByText("Cannot erase: user has an active legal hold"),
    ).toBeInTheDocument();
    expect(screen.getByText(LEGAL_HOLD_ACTIVE)).toBeInTheDocument();
    expect(screen.getByText(/req-hold-1/)).toBeInTheDocument();
  });
});
