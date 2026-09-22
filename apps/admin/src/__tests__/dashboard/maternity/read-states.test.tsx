import MaternityPage from "@/app/(with-auth)/dashboard/maternity/page";
import { fetchAdminAPI } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("@/lib/api", () => ({ fetchAdminAPI: jest.fn() }));

const mockFetch = jest.mocked(fetchAdminAPI);
const labor = {
  id: 31,
  pregnancy_id: 12,
  patient_uid: "11111111-1111-4111-8111-111111111111",
  admitted_at: "2026-09-16T08:00:00Z",
  gravida: 2,
  parity: 1,
  high_risk: false,
};
const entry = {
  id: 41,
  recorded_at: "2026-09-16T09:00:00Z",
  cervix_dilation_cm: 4,
  fetal_heart_rate_bpm: 143,
};
const clients: QueryClient[] = [];

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MaternityPage />
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  mockFetch.mockReset();
});

describe.each([
  {
    name: "labour board",
    endpoint: "/maternity/labor-admissions/active?limit=50",
    queryKey: ["maternity", "labor-admissions", "active"],
    emptyTitle: "Labour ward is quiet",
    errorTitle: "Unable to load labour board.",
    row: labor,
    populatedText: "11111111",
    drilldown: false,
  },
  {
    name: "partograph",
    endpoint: "/maternity/partograph/labor/31",
    queryKey: ["maternity", "partograph", 31],
    emptyTitle: "No partograph entries",
    errorTitle: "Unable to load partograph.",
    row: entry,
    populatedText: "143",
    drilldown: true,
  },
])("maternity $name read states", (view) => {
  async function openWith(response: () => Promise<unknown>) {
    mockFetch.mockImplementation((endpoint) =>
      endpoint === view.endpoint ? response() : Promise.resolve([labor]),
    );
    const client = renderPage();
    if (view.drilldown) {
      await userEvent.click(
        await screen.findByRole("button", { name: "Partograph →" }),
      );
    }
    return client;
  }

  function expectFailure() {
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(view.errorTitle);
    expect(alert).toHaveTextContent("Please retry.");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.queryByText(view.emptyTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(view.populatedText)).not.toBeInTheDocument();
    expect(screen.queryByText(/sensitive diagnostic/)).not.toBeInTheDocument();
  }

  it.each([403, "network"])(
    "shows only an actionable generic error after an initial %s failure",
    async (failure) => {
      await openWith(() =>
        Promise.reject(
          Object.assign(new Error("sensitive diagnostic"), {
            status: failure,
          }),
        ),
      );
      await screen.findByRole("alert");
      expectFailure();
    },
  );

  it.each([null, {}, { data: null }, { data: {} }, "invalid"])(
    "rejects a malformed successful array container: %j",
    async (response) => {
      await openWith(() => Promise.resolve(response));
      await screen.findByRole("alert");
      expectFailure();
    },
  );

  it.each([false, true])(
    "preserves a genuine empty result (envelope=%s)",
    async (envelope) => {
      await openWith(() => Promise.resolve(envelope ? { data: [] } : []));
      expect(await screen.findByText(view.emptyTitle)).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(mockFetch).toHaveBeenCalledWith(view.endpoint);
    },
  );

  it.each([false, true])(
    "preserves populated results (envelope=%s)",
    async (envelope) => {
      await openWith(() =>
        Promise.resolve(envelope ? { data: [view.row] } : [view.row]),
      );
      expect(await screen.findByText(view.populatedText)).toBeVisible();
      expect(screen.queryByText(view.emptyTitle)).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("hides cached clinical rows after a failed refresh and recovers on retry", async () => {
    let fail = false;
    const client = await openWith(() =>
      fail
        ? Promise.reject(new Error("sensitive diagnostic"))
        : Promise.resolve([view.row]),
    );
    expect(await screen.findByText(view.populatedText)).toBeVisible();
    fail = true;
    await act(async () => {
      await client.refetchQueries({ queryKey: view.queryKey, exact: true });
    });
    await screen.findByRole("alert");
    expect(client.getQueryData(view.queryKey)).toEqual([view.row]);
    expectFailure();
    fail = false;
    await userEvent.click(
      within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }),
    );
    expect(await screen.findByText(view.populatedText)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retries an initial failure into a genuine empty result", async () => {
    let fail = true;
    await openWith(() =>
      fail
        ? Promise.reject(new Error("sensitive diagnostic"))
        : Promise.resolve([]),
    );
    await screen.findByRole("alert");
    fail = false;
    await userEvent.click(
      within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }),
    );
    expect(await screen.findByText(view.emptyTitle)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

it("keeps switched labour drilldowns isolated when the previous request resolves last", async () => {
  let resolveFirst!: (rows: unknown) => void;
  let resolveSecond!: (rows: unknown) => void;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const second = new Promise((resolve) => {
    resolveSecond = resolve;
  });
  mockFetch.mockImplementation((endpoint) => {
    if (endpoint === "/maternity/partograph/labor/31") return first;
    if (endpoint === "/maternity/partograph/labor/32") return second;
    return Promise.resolve([
      labor,
      {
        ...labor,
        id: 32,
        patient_uid: "22222222-2222-4222-8222-222222222222",
      },
    ]);
  });
  const client = renderPage();
  const buttons = await screen.findAllByRole("button", {
    name: "Partograph →",
  });
  await userEvent.click(buttons[0]);
  await waitFor(() =>
    expect(mockFetch).toHaveBeenCalledWith("/maternity/partograph/labor/31"),
  );
  await userEvent.click(screen.getByRole("button", { name: "✕" }));
  await userEvent.click(buttons[1]);
  expect(
    screen.getByRole("heading", { name: "Partograph — Labor #32" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(mockFetch).toHaveBeenCalledWith("/maternity/partograph/labor/32"),
  );
  await act(async () => {
    resolveSecond([{ ...entry, id: 42, fetal_heart_rate_bpm: 151 }]);
  });
  expect(await screen.findByText("151")).toBeVisible();
  await act(async () => {
    resolveFirst([entry]);
  });
  await waitFor(() =>
    expect(client.getQueryData(["maternity", "partograph", 31])).toEqual([
      entry,
    ]),
  );
  expect(
    screen.getByRole("heading", { name: "Partograph — Labor #32" }),
  ).toBeVisible();
  expect(screen.getByText("151")).toBeVisible();
  expect(screen.queryByText("143")).not.toBeInTheDocument();
});
