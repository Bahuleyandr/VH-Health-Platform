// Feedback console — the overview must not publish a KPI nothing can move.
//
// The page used to render a "Response Rate" card from
// `overallStats.responded_count / total_feedback`. Nothing writes
// `feedback.response_status`: the only writer was `respondToFeedback`, which
// INSERTed into a `feedback_responses` table that exists in no migration and
// so raised 42P01 on every call — removed in re-audit lane I (see the removal
// note in services/feedback/feedbackService.js). The card could therefore only
// ever read 0%, which an operator reads as "we answer no one" rather than
// "this platform has no reply feature". The detail panel's "Response:" block
// was dead for the same reason — no endpoint returns reply text for a feedback
// row.
//
// The real service-recovery numbers are on the NPS tab, and those are wired.

import FeedbackPage from "@/app/(with-auth)/dashboard/feedback/page";
import { fetchAdminAPI } from "@/lib/api";
import { fetchAdminAPI as realFetchAdminAPI } from "@/lib/api/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster, toast } from "react-hot-toast";

jest.mock("@/lib/api", () => {
  const actual = jest.requireActual("@/lib/api");
  return {
    ...actual,
    fetchAdminAPI: jest.fn(),
  };
});

jest.mock("react-hot-toast", () => jest.requireActual("react-hot-toast"));

const fetchAdminAPIMock = fetchAdminAPI as jest.Mock;
const queryClients: QueryClient[] = [];

const FEEDBACK_ROW = {
  id: 11,
  patient_name: "Asha K",
  department: "Cardiology",
  rating: 4,
  comment: "Seen on time",
  category: "GENERAL",
  status: "PENDING",
  created_at: "2026-08-20T09:00:00.000Z",
};

function renderPage(
  recentFeedback: () => Promise<unknown> = () =>
    Promise.resolve({ data: [FEEDBACK_ROW] }),
) {
  // The dashboard reports what the backend actually stores: totals and an
  // average. `responded_count` is deliberately absent — see the header.
  fetchAdminAPIMock.mockImplementation((endpoint: string) => {
    if (endpoint.startsWith("/feedback/recent")) {
      return recentFeedback();
    }
    if (endpoint.startsWith("/feedback/dashboard")) {
      return Promise.resolve({
        data: { overallStats: { total_feedback: 40, average_rating: 4.2 } },
      });
    }
    if (endpoint.startsWith("/quality/nps/dashboard")) {
      return Promise.resolve({ data: { overall: null, urgent_queue: [] } });
    }
    return Promise.resolve({ data: null });
  });

  return renderPageWithClient();
}

function renderPageWithClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60 * 1000, refetchOnWindowFocus: false },
    },
  });
  queryClients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <FeedbackPage />
    </QueryClientProvider>,
  );
}

async function advanceTime(milliseconds: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("<FeedbackPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    for (const client of queryClients) client.clear();
    queryClients.length = 0;
    jest.useRealTimers();
  });

  it("publishes the totals it can actually compute", async () => {
    renderPage();
    expect(await screen.findByText("Total Feedback")).toBeInTheDocument();
    expect(screen.getByText("Average Rating")).toBeInTheDocument();
  });

  it("does not publish a feedback response rate", async () => {
    renderPage();
    await screen.findByText("Total Feedback");
    // The NPS tab owns the only response rate this platform can measure, and
    // it is not rendered on the overview strip.
    expect(screen.queryByText("Response Rate")).not.toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("names the search and filters and keeps them in keyboard order", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(FEEDBACK_ROW.patient_name);

    const search = screen.getByRole("textbox", { name: "Search feedback" });
    const rating = screen.getByRole("combobox", { name: "Filter by rating" });
    const department = screen.getByRole("combobox", {
      name: "Filter by department",
    });

    await user.tab();
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: /^Feedback$/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Statistics" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: /^NPS$/ })).toHaveFocus();
    await user.tab();
    expect(search).toHaveFocus();
    await user.tab();
    expect(rating).toHaveFocus();
    await user.tab();
    expect(department).toHaveFocus();
  });

  it("preserves search and combined rating and department filtering", async () => {
    const user = userEvent.setup();
    const rows = [
      FEEDBACK_ROW,
      {
        ...FEEDBACK_ROW,
        id: 12,
        patient_name: "Ravi S",
        department: "Neurology",
        rating: 2,
        comment: "Long wait",
      },
      {
        ...FEEDBACK_ROW,
        id: 13,
        patient_name: "Meera P",
        department: "Neurology",
        comment: "Clear explanation",
      },
    ];
    renderPage(() => Promise.resolve({ data: rows }));
    await screen.findByText("Meera P");

    const search = screen.getByRole("textbox", { name: "Search feedback" });
    const rating = screen.getByRole("combobox", { name: "Filter by rating" });
    const department = screen.getByRole("combobox", {
      name: "Filter by department",
    });

    await user.type(search, "seen on time");
    expect(screen.getByText("Asha K")).toBeInTheDocument();
    expect(screen.queryByText("Ravi S")).not.toBeInTheDocument();
    expect(screen.queryByText("Meera P")).not.toBeInTheDocument();

    await user.clear(search);
    await user.selectOptions(rating, "4");
    expect(screen.getByText("Asha K")).toBeInTheDocument();
    expect(screen.getByText("Meera P")).toBeInTheDocument();
    expect(screen.queryByText("Ravi S")).not.toBeInTheDocument();

    await user.selectOptions(department, "Neurology");
    expect(screen.getByText("Meera P")).toBeInTheDocument();
    expect(screen.queryByText("Asha K")).not.toBeInTheDocument();
    expect(screen.queryByText("Ravi S")).not.toBeInTheDocument();

    await user.selectOptions(rating, "all");
    expect(screen.getByText("Ravi S")).toBeInTheDocument();
    expect(screen.queryByText("Asha K")).not.toBeInTheDocument();
    await user.selectOptions(department, "all");
    for (const row of rows) {
      expect(screen.getByText(row.patient_name)).toBeInTheDocument();
    }
  });

  it("returns keyboard focus to the invoking View button when Details closes", async () => {
    const user = userEvent.setup();
    renderPage(() =>
      Promise.resolve({
        data: [
          FEEDBACK_ROW,
          { ...FEEDBACK_ROW, id: 12, patient_name: "Ravi S" },
        ],
      }),
    );
    await screen.findByText("Ravi S");
    const firstRow = screen.getByRole("row", { name: /Asha K/ });
    const secondRow = screen.getByRole("row", { name: /Ravi S/ });
    const firstView = within(firstRow).getByRole("button", { name: "View" });
    const opener = within(secondRow).getByRole("button", { name: "View" });

    for (let index = 0; index < 9; index++) await user.tab();
    expect(opener).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("Feedback Details")).toBeVisible();
    expect(opener).toHaveFocus();
    await user.tab({ shift: true });
    expect(firstView).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.queryByText("Feedback Details")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it.each([
    { name: "stable row IDs", firstId: 11, secondId: 12, openerReused: false },
    {
      name: "index-keyed rows",
      firstId: undefined,
      secondId: undefined,
      openerReused: true,
    },
  ])(
    "returns focus to search when filtering removes the opener with $name",
    async ({ firstId, secondId, openerReused }) => {
      const user = userEvent.setup();
      renderPage(() =>
        Promise.resolve({
          data: [
            { ...FEEDBACK_ROW, id: firstId },
            { ...FEEDBACK_ROW, id: secondId, patient_name: "Ravi S" },
          ],
        }),
      );
      await screen.findByText("Ravi S");
      const originalRow = screen.getByRole("row", { name: /Asha K/ });
      const opener = within(originalRow).getByRole("button", { name: "View" });
      const search = screen.getByRole("textbox", { name: "Search feedback" });

      for (let index = 0; index < 8; index++) await user.tab();
      expect(opener).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.getByText("Feedback Details")).toBeVisible();
      for (let index = 0; index < 4; index++) await user.tab({ shift: true });
      expect(search).toHaveFocus();
      await user.type(search, "Ravi S");

      expect(
        screen.queryByRole("row", { name: /Asha K/ }),
      ).not.toBeInTheDocument();
      expect(opener.isConnected).toBe(openerReused);
      if (openerReused) {
        const remainingRow = screen.getByRole("row", { name: /Ravi S/ });
        expect(within(remainingRow).getByRole("button", { name: "View" })).toBe(
          opener,
        );
      }
      for (let index = 0; index < 3; index++) await user.tab();
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
      await user.keyboard("{Enter}");

      expect(screen.queryByText("Feedback Details")).not.toBeInTheDocument();
      expect(search).toHaveFocus();
      expect(search).toHaveValue("Ravi S");
      expect(screen.getByRole("row", { name: /Ravi S/ })).toBeInTheDocument();
    },
  );

  it.each([1, 4, 5])(
    "exposes a %i-star rating in the list and details without duplicating the average",
    async (rating) => {
      const user = userEvent.setup();
      renderPage(() =>
        Promise.resolve({ data: [{ ...FEEDBACK_ROW, rating }] }),
      );
      await screen.findByText(FEEDBACK_ROW.patient_name);
      expect(await screen.findByText("4.2")).toBeInTheDocument();

      const row = screen.getByRole("row", { name: /Asha K/ });
      const ratingImage = within(row).getByRole("img", {
        name: `${rating} out of 5 stars`,
      });
      const stars = ratingImage.querySelectorAll("svg");
      expect(stars).toHaveLength(5);
      for (const star of stars) {
        expect(star).toHaveAttribute("aria-hidden", "true");
      }
      expect(
        screen.getAllByRole("img", { name: /out of 5 stars/ }),
      ).toHaveLength(1);

      await user.click(within(row).getByRole("button", { name: "View" }));
      expect(screen.getByText("Feedback Details")).toBeInTheDocument();
      expect(
        screen.getAllByRole("img", { name: `${rating} out of 5 stars` }),
      ).toHaveLength(2);
    },
  );

  it("announces an asynchronous list failure and clears it after refresh succeeds", async () => {
    jest.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const failure = new Error("Failed to fetch recent feedback");
    let rejectRecent!: (reason: Error) => void;
    const pendingFeedback = new Promise<never>((_resolve, reject) => {
      rejectRecent = reject;
    });
    const recentFeedback = jest
      .fn()
      .mockImplementationOnce(() => pendingFeedback)
      .mockRejectedValue(failure);
    renderPage(recentFeedback);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      rejectRecent(failure);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await advanceTime(7000);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to fetch recent feedback",
    );
    expect(recentFeedback).toHaveBeenCalledTimes(4);

    recentFeedback.mockResolvedValue({ data: [FEEDBACK_ROW] });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByText(FEEDBACK_ROW.patient_name),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(recentFeedback).toHaveBeenCalledTimes(5);
  });

  describe("shared API error announcements", () => {
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "matchMedia",
    );

    beforeEach(() => {
      jest.useFakeTimers();
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: jest.fn((query: string) => ({
          matches: true,
          media: query,
          onchange: null,
          addListener: jest.fn(),
          removeListener: jest.fn(),
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
          dispatchEvent: jest.fn(() => true),
        })),
      });
    });

    afterEach(() => {
      act(() => toast.remove());
      jest.restoreAllMocks();
      if (matchMediaDescriptor) {
        Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
      } else {
        Reflect.deleteProperty(window, "matchMedia");
      }
    });

    function renderApiFailure(status: number, message: string) {
      const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(JSON.stringify({ success: false, message }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      );
      render(
        <Toaster position="top-right" toastOptions={{ duration: 3500 }} />,
      );
      renderPage(() => realFetchAdminAPI("/feedback/recent?limit=100"));
      return fetchMock;
    }

    it.each([
      {
        endpoint: "/feedback/recent?limit=100",
        recoveredText: FEEDBACK_ROW.patient_name,
      },
      {
        endpoint: "/feedback/dashboard?timeframe=30d",
        recoveredText: "4.2",
      },
      {
        endpoint: "/quality/nps/dashboard?days=30&minimum_sample_size=5",
        recoveredText: "75",
      },
    ])(
      "does not retry a real 403 from $endpoint and allows explicit refresh",
      async ({ endpoint, recoveredText }) => {
        const user = userEvent.setup({
          advanceTimers: jest.advanceTimersByTime,
        });
        const permissionToastSpy = jest.spyOn(toast, "error");
        const responses = new Map<string, unknown>([
          ["/api/proxy/api/v1/feedback/recent?limit=100", [FEEDBACK_ROW]],
          [
            "/api/proxy/api/v1/feedback/dashboard?timeframe=30d",
            { overallStats: { total_feedback: 40, average_rating: 4.2 } },
          ],
          [
            "/api/proxy/api/v1/quality/nps/dashboard?days=30&minimum_sample_size=5",
            { overall: { nps_score: 75 }, urgent_queue: [] },
          ],
        ]);
        let forbidden = true;
        const fetchMock = jest
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input) => {
            const url = String(input);
            if (forbidden && url === `/api/proxy/api/v1${endpoint}`) {
              return Response.json(
                { success: false, message: "Staff access required" },
                { status: 403 },
              );
            }
            if (!responses.has(url)) {
              throw new Error(`Unexpected request: ${url}`);
            }
            return Response.json({ success: true, data: responses.get(url) });
          });
        fetchAdminAPIMock.mockImplementation(realFetchAdminAPI);
        render(
          <Toaster position="top-right" toastOptions={{ duration: 3500 }} />,
        );
        renderPageWithClient();

        const permissionToast = await screen.findByRole("status");
        expect(permissionToast).toHaveAttribute("aria-live", "polite");
        expect(permissionToast).toHaveTextContent(
          "You do not have permission to perform this action.",
        );
        for (const url of responses.keys()) {
          expect(fetchMock).toHaveBeenCalledWith(
            url,
            expect.objectContaining({ method: "GET" }),
          );
        }
        expect([
          ...screen.queryAllByRole("status"),
          ...screen.queryAllByRole("alert"),
        ]).toHaveLength(1);
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();

        // Commit toast dismissal before advancing its separate removal timer.
        for (const delay of [1000, 2000, 500, 1000, 2500]) {
          await advanceTime(delay);
          expect(fetchMock).toHaveBeenCalledTimes(3);
          expect(permissionToastSpy).toHaveBeenCalledTimes(1);
          expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        }
        if (endpoint.startsWith("/feedback/recent")) {
          expect(screen.getByText("Forbidden")).toBeVisible();
        }
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(screen.queryByText(recoveredText)).not.toBeInTheDocument();

        forbidden = false;
        await user.click(screen.getByRole("button", { name: "Refresh" }));
        expect(await screen.findByText(recoveredText)).toBeInTheDocument();
        expect(screen.queryByText("Forbidden")).not.toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        for (const url of responses.keys()) {
          expect(
            fetchMock.mock.calls.filter(([input]) => input === url),
          ).toHaveLength(2);
        }
        expect(fetchMock).toHaveBeenCalledTimes(6);
        expect(permissionToastSpy).toHaveBeenCalledTimes(1);
      },
    );

    it("preserves three real 500 retries and announces one terminal error before refresh recovery", async () => {
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const permissionToastSpy = jest.spyOn(toast, "error");
      const fetchMock = renderApiFailure(
        500,
        "Failed to fetch recent feedback",
      );

      await advanceTime(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      for (const [index, delay] of [1000, 2000, 4000].entries()) {
        await advanceTime(delay - 1);
        expect(fetchMock).toHaveBeenCalledTimes(index + 1);
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        await advanceTime(1);
        expect(fetchMock).toHaveBeenCalledTimes(index + 2);
      }
      const inlineAlert = await screen.findByRole("alert");
      expect(inlineAlert).toBeVisible();
      expect(inlineAlert).toHaveTextContent("Failed to fetch recent feedback");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(permissionToastSpy).not.toHaveBeenCalled();
      await advanceTime(30000);
      expect(fetchMock).toHaveBeenCalledTimes(4);

      fetchMock.mockImplementation(async () =>
        Response.json({ success: true, data: [FEEDBACK_ROW] }),
      );
      await user.click(screen.getByRole("button", { name: "Refresh" }));
      expect(
        await screen.findByText(FEEDBACK_ROW.patient_name),
      ).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(permissionToastSpy).not.toHaveBeenCalled();
    });

    it("recovers from a transient real 500 on the automatic retry", async () => {
      const permissionToastSpy = jest.spyOn(toast, "error");
      const fetchMock = renderApiFailure(
        500,
        "Failed to fetch recent feedback",
      );

      await advanceTime(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      fetchMock.mockImplementation(async () =>
        Response.json({ success: true, data: [FEEDBACK_ROW] }),
      );
      await advanceTime(1000);
      expect(
        await screen.findByText(FEEDBACK_ROW.patient_name),
      ).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(permissionToastSpy).not.toHaveBeenCalled();
    });
  });
});
