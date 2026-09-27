import IncidentsPage from "@/app/(with-auth)/dashboard/incidents/page";
import {
  getIncidents,
  getIncidentStats,
  updateIncident,
} from "@/lib/api/reports";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { toast } from "react-hot-toast";

jest.mock("@/lib/api/reports", () => ({
  getIncidents: jest.fn(),
  getIncidentStats: jest.fn(),
  updateIncident: jest.fn(),
}));

jest.mock("react-hot-toast", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const mockRealtime = jest.fn((..._args: unknown[]) => ({
  connected: false,
  subscribed: false,
  denied: null as string | null,
  lastEventAt: null as number | null,
}));
jest.mock("@/hooks/useRealtimeInvalidation", () => ({
  useRealtimeInvalidation: (...args: unknown[]) => mockRealtime(...args),
}));

const mockedGetIncidents = getIncidents as jest.MockedFunction<
  typeof getIncidents
>;
const mockedGetIncidentStats = getIncidentStats as jest.MockedFunction<
  typeof getIncidentStats
>;
const mockedUpdateIncident = updateIncident as jest.MockedFunction<
  typeof updateIncident
>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("<IncidentsPage />", () => {
  const incident = {
    id: 1,
    report_number: "INC-001",
    incident_type: "patient_fall",
    severity: "moderate",
    title: "Ward fall",
    description: "Incident description",
    incident_date: "2026-09-25T12:00:00Z",
    status: "submitted",
    priority: "normal",
    patient_involved: false,
    is_anonymous: true,
    created_at: "2026-09-25T12:00:00Z",
  };

  type IncidentResponse = { incidents: (typeof incident)[]; total: number };

  async function openIncidentWithDeferredDetails() {
    const user = userEvent.setup();
    const details: ReturnType<typeof deferred<IncidentResponse>>[] = [];
    let captureDetails = false;
    mockedGetIncidents.mockImplementation((params) => {
      if (captureDetails && !params?.status) {
        const request = deferred<IncidentResponse>();
        details.push(request);
        return request.promise as never;
      }
      return Promise.resolve({ incidents: [incident], total: 1 }) as never;
    });
    renderWithQuery(<IncidentsPage />);
    await screen.findByRole("button", {
      name: "Review incident INC-001: Ward fall",
    });
    await user.selectOptions(
      screen.getByDisplayValue("All Statuses"),
      "submitted",
    );
    const opener = await screen.findByRole("button", {
      name: "Review incident INC-001: Ward fall",
    });
    await user.click(opener);
    captureDetails = true;
    return {
      user,
      opener,
      details,
      dialog: screen.getByRole("dialog", { name: "Ward fall" }),
    };
  }

  async function resolveDetail(
    request: ReturnType<typeof deferred<IncidentResponse>>,
    title: string,
  ) {
    await act(async () => {
      request.resolve({ incidents: [{ ...incident, title }], total: 1 });
      await request.promise;
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedUpdateIncident.mockReset();
    mockedUpdateIncident.mockResolvedValue({} as never);
    mockRealtime.mockReturnValue({
      connected: false,
      subscribed: false,
      denied: null,
      lastEventAt: null,
    });
    mockedGetIncidents.mockResolvedValue({ incidents: [], total: 0 } as never);
    mockedGetIncidentStats.mockResolvedValue({
      summary: {
        new_count: "0",
        active_count: "0",
        sentinel_count: "0",
        severe_count: "0",
        this_week: "0",
        this_month: "0",
        total: "0",
      },
      by_type: [],
    } as never);
  });

  it("subscribes to staff:incidents on both roots and shows ○ Offline when disconnected", async () => {
    renderWithQuery(<IncidentsPage />);
    const ind = await screen.findByTestId("incidents-realtime-indicator");
    expect(ind).toHaveTextContent("Offline");
    expect(mockRealtime).toHaveBeenCalledWith("staff:incidents", [
      ["incidents"],
      ["incident-stats"],
    ]);
  });

  it("shows ● Live when subscribed", async () => {
    mockRealtime.mockReturnValue({
      connected: true,
      subscribed: true,
      denied: null,
      lastEventAt: Date.now(),
    });
    renderWithQuery(<IncidentsPage />);
    const ind = await screen.findByTestId("incidents-realtime-indicator");
    expect(ind).toHaveTextContent("Live");
  });

  it("opens the named incident dialog by keyboard and returns focus after closing", async () => {
    const user = userEvent.setup();
    mockedGetIncidents.mockResolvedValue({
      incidents: [incident],
      total: 1,
    } as never);
    renderWithQuery(<IncidentsPage />);

    const opener = await screen.findByRole("button", {
      name: "Review incident INC-001: Ward fall",
    });
    opener.focus();
    await user.keyboard("{Enter}");

    const dialog = screen.getByRole("dialog", { name: "Ward fall" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const close = within(dialog).getByRole("button", {
      name: "Close incident details",
    });
    expect(close).toHaveFocus();

    await user.tab({ shift: true });
    expect(
      within(dialog).getByRole("button", { name: "Save Changes" }),
    ).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.click(close);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes the incident dialog with Escape and returns focus to its review button", async () => {
    const user = userEvent.setup();
    mockedGetIncidents.mockResolvedValue({
      incidents: [incident],
      total: 1,
    } as never);
    renderWithQuery(<IncidentsPage />);

    const opener = await screen.findByRole("button", {
      name: "Review incident INC-001: Ward fall",
    });
    opener.focus();
    await user.keyboard(" ");
    expect(
      screen.getByRole("dialog", { name: "Ward fall" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("does not present the whole incident row as clickable", async () => {
    const user = userEvent.setup();
    mockedGetIncidents.mockResolvedValue({
      incidents: [incident],
      total: 1,
    } as never);
    renderWithQuery(<IncidentsPage />);

    const opener = await screen.findByRole("button", {
      name: "Review incident INC-001: Ward fall",
    });
    const row = opener.closest("tr");
    expect(row).not.toHaveClass("hover:bg-blue-50");
    expect(opener).toHaveClass("hover:underline");
    await user.click(within(row!).getByText("Ward fall"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(opener);
    expect(
      screen.getByRole("dialog", { name: "Ward fall" }),
    ).toBeInTheDocument();
  });

  it("returns focus to Refresh when an update removes the filtered opener row", async () => {
    const user = userEvent.setup();
    let savedStatus = "submitted";
    mockedGetIncidents.mockImplementation(async (params) => {
      const incidents =
        params?.status && params.status !== savedStatus
          ? []
          : [{ ...incident, status: savedStatus }];
      return { incidents, total: incidents.length } as never;
    });
    mockedUpdateIncident.mockImplementation(async () => {
      savedStatus = "resolved";
      return {} as never;
    });
    renderWithQuery(<IncidentsPage />);

    await user.selectOptions(screen.getAllByRole("combobox")[0], "submitted");
    const opener = await screen.findByRole("button", {
      name: "Review incident INC-001: Ward fall",
    });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Ward fall" });
    await user.selectOptions(within(dialog).getByRole("combobox"), "resolved");
    await user.click(
      within(dialog).getByRole("button", { name: "Save Changes" }),
    );

    await waitFor(() => expect(opener).not.toBeInTheDocument());
    await user.click(
      within(dialog).getByRole("button", { name: "Close incident details" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
  });

  it("names all filters and associates every incident form label with its control", async () => {
    const user = userEvent.setup();
    mockedGetIncidents.mockResolvedValue({
      incidents: [incident],
      total: 1,
    } as never);
    renderWithQuery(<IncidentsPage />);

    for (const name of [
      "Filter by status",
      "Filter by severity",
      "Filter by type",
    ]) {
      expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
    }
    await user.click(
      await screen.findByRole("button", {
        name: "Review incident INC-001: Ward fall",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Ward fall" });
    const status = within(dialog).getByRole("combobox", { name: "Status" });
    expect(within(dialog).getByLabelText("Status")).toBe(status);
    for (const name of [
      "Public Update (visible to reporter)",
      /Internal Note \(admin only — not visible to reporter\)/,
      "Admin Notes (private)",
    ]) {
      const control = within(dialog).getByRole("textbox", { name });
      expect(within(dialog).getByLabelText(name)).toBe(control);
    }
    expect(
      within(dialog).queryByRole("textbox", {
        name: "Resolution (visible to reporter)",
      }),
    ).not.toBeInTheDocument();
    await user.selectOptions(status, "resolved");
    expect(
      within(dialog).getByLabelText("Resolution (visible to reporter)"),
    ).toBe(
      within(dialog).getByRole("textbox", {
        name: "Resolution (visible to reporter)",
      }),
    );
  });

  it("keeps Tab inside the dialog while Save is disabled for a pending update", async () => {
    const save = deferred<unknown>();
    mockedUpdateIncident.mockReturnValue(save.promise as never);
    const { user, dialog, details } = await openIncidentWithDeferredDetails();
    await user.click(
      within(dialog).getByRole("button", { name: "Save Changes" }),
    );
    expect(
      within(dialog).getByRole("button", { name: "Saving..." }),
    ).toBeDisabled();

    const close = within(dialog).getByRole("button", {
      name: "Close incident details",
    });
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getAllByRole("textbox").at(-1)).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await act(async () => {
      save.resolve({});
      await save.promise;
    });
    await waitFor(() => expect(details).toHaveLength(1));
    await resolveDetail(details[0], incident.title);
    expect(
      within(dialog).getByRole("button", { name: "Save Changes" }),
    ).toBeEnabled();
  });

  it("does not reopen a dismissed incident when its detail response arrives", async () => {
    const { user, opener, dialog, details } =
      await openIncidentWithDeferredDetails();
    await user.click(
      within(dialog).getByRole("button", { name: "Save Changes" }),
    );
    await waitFor(() => expect(details).toHaveLength(1));
    await user.click(
      within(dialog).getByRole("button", { name: "Close incident details" }),
    );
    await resolveDetail(details[0], "Late incident detail");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("rejects an old detail response after closing and reopening the same incident", async () => {
    const { user, opener, dialog, details } =
      await openIncidentWithDeferredDetails();
    await user.click(
      within(dialog).getByRole("button", { name: "Save Changes" }),
    );
    await waitFor(() => expect(details).toHaveLength(1));
    await user.click(
      within(dialog).getByRole("button", { name: "Close incident details" }),
    );
    await user.click(opener);
    const reopened = screen.getByRole("dialog", { name: "Ward fall" });
    const publicUpdate = within(reopened).getByPlaceholderText(
      "Update the reporter on progress...",
    );
    await user.type(publicUpdate, "Unsaved update in the new opening");
    await resolveDetail(details[0], "Detail from the previous opening");

    expect(screen.getByRole("dialog", { name: "Ward fall" })).toBe(reopened);
    expect(publicUpdate).toHaveValue("Unsaved update in the new opening");
    expect(publicUpdate).toHaveFocus();
  });

  it("does not refresh a reopened incident when a save from its previous opening completes", async () => {
    const save = deferred<unknown>();
    mockedUpdateIncident.mockReturnValue(save.promise as never);
    const { user, opener, dialog, details } =
      await openIncidentWithDeferredDetails();
    await user.click(
      within(dialog).getByRole("button", { name: "Save Changes" }),
    );
    expect(
      within(dialog).getByRole("button", { name: "Saving..." }),
    ).toBeDisabled();
    await user.click(
      within(dialog).getByRole("button", { name: "Close incident details" }),
    );
    await user.click(opener);
    const reopened = screen.getByRole("dialog", { name: "Ward fall" });
    const publicUpdate = within(reopened).getByPlaceholderText(
      "Update the reporter on progress...",
    );
    await user.type(publicUpdate, "Current opening draft");
    await act(async () => {
      save.resolve({});
      await save.promise;
    });
    for (const request of details) {
      await resolveDetail(request, "Detail requested by an obsolete save");
    }

    expect(mockedUpdateIncident).toHaveBeenCalledTimes(1);
    expect(details).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "Ward fall" })).toBe(reopened);
    expect(publicUpdate).toHaveValue("Current opening draft");
    expect(publicUpdate).toHaveFocus();
  });

  it("does not replace newer panel data with an older detail response", async () => {
    const { user, dialog, details } = await openIncidentWithDeferredDetails();
    await user.click(
      within(dialog).getByRole("button", { name: "Save Changes" }),
    );
    await waitFor(() => expect(details).toHaveLength(1));
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", {
          name: "Save Changes",
        }),
      ).toBeEnabled(),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Save Changes" }),
    );
    await waitFor(() => expect(details).toHaveLength(2));
    await resolveDetail(details[1], "Newest incident detail");
    expect(
      screen.getByRole("dialog", { name: "Newest incident detail" }),
    ).toBeInTheDocument();
    await resolveDetail(details[0], "Older incident detail");

    expect(
      screen.getByRole("dialog", { name: "Newest incident detail" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Older incident detail" }),
    ).not.toBeInTheDocument();
  });

  it("reports a failed detail refresh while its incident opening is still current", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const { user, dialog, details } = await openIncidentWithDeferredDetails();
      await user.click(
        within(dialog).getByRole("button", { name: "Save Changes" }),
      );
      await waitFor(() => expect(details).toHaveLength(1));
      await act(async () => {
        details[0].reject(new Error("Synthetic detail request failure"));
        await details[0].promise.catch(() => undefined);
      });

      expect(toast.error).toHaveBeenCalledWith(
        "Update saved, but the detail panel could not refresh",
      );
      expect(screen.getByRole("dialog", { name: "Ward fall" })).toBe(dialog);
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([false, true])(
    "ignores a late rejected detail request after dismissal (reopened: %s)",
    async (reopen) => {
      const consoleError = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      try {
        const { user, opener, dialog, details } =
          await openIncidentWithDeferredDetails();
        await user.click(
          within(dialog).getByRole("button", { name: "Save Changes" }),
        );
        await waitFor(() => expect(details).toHaveLength(1));
        await user.click(
          within(dialog).getByRole("button", {
            name: "Close incident details",
          }),
        );
        if (reopen) await user.click(opener);
        await act(async () => {
          details[0].reject(new Error("Synthetic detail request failure"));
          await details[0].promise.catch(() => undefined);
        });

        expect(toast.error).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
        if (reopen) {
          expect(
            screen.getByRole("dialog", { name: "Ward fall" }),
          ).toBeInTheDocument();
        } else {
          expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
          expect(opener).toHaveFocus();
        }
      } finally {
        consoleError.mockRestore();
      }
    },
  );
});
