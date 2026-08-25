// Feature-flag console — the page must not claim an effect the backend says
// the flag does not have.
//
// GET /admin/feature-flags stamps every row with `inert` / `runtime_effect` /
// `runtime_note` (services/featureFlags/featureFlagService.js). Before this
// suite the page ignored all three: it advertised "dynamic feature rollout",
// showed a green Enabled pill and toasted "Flag toggled" for a flag that
// `isEnabled()` — which has no call sites — gates nothing. These tests pin the
// three claims the page is allowed to make: it gates something, it gates
// nothing, or the server did not say.

import FeatureFlagsPage from "@/app/(with-auth)/dashboard/feature-flags/page";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "react-hot-toast";

jest.mock("@/lib/api", () => {
  const actual = jest.requireActual("@/lib/api");
  return {
    ...actual,
    fetchAdminAPI: jest.fn(),
  };
});

jest.mock("react-hot-toast", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

import { fetchAdminAPI } from "@/lib/api";

const fetchAdminAPIMock = fetchAdminAPI as jest.Mock;

/** The note featureFlagService.js attaches to every inert row. */
const INERT_NOTE =
  "No code path consults this flag. Toggling it changes no runtime behaviour. " +
  "See services/featureFlags/featureFlagService.js and the retirement entry in docs/ROADMAP.md.";

const INERT_FLAG = {
  id: 1,
  name: "enable_telemedicine",
  enabled: true,
  description: "Legacy record",
  updated_at: "2026-08-20T10:00:00.000Z",
  inert: true,
  runtime_effect: "none",
  runtime_note: INERT_NOTE,
};

/** What a row would look like once a gate joins WIRED_FEATURE_FLAGS. */
const GATED_FLAG = {
  id: 2,
  name: "wired_example",
  enabled: true,
  description: "Read by a real code path",
  updated_at: "2026-08-20T10:00:00.000Z",
  inert: false,
  runtime_effect: "gated",
};

/** A backend that predates the metadata: neither claim may be made for it. */
const SILENT_FLAG = {
  id: 3,
  name: "old_backend_flag",
  enabled: false,
  description: "Server said nothing",
  updated_at: "2026-08-20T10:00:00.000Z",
};

function primeList(flags: unknown[]) {
  fetchAdminAPIMock.mockImplementation((endpoint: string, init?: unknown) => {
    if (endpoint === "/admin/feature-flags" && !init) {
      return Promise.resolve({ data: flags });
    }
    return Promise.resolve({ data: null });
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FeatureFlagsPage />
    </QueryClientProvider>,
  );
}

describe("<FeatureFlagsPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not advertise a rollout control the console does not have", async () => {
    primeList([INERT_FLAG]);
    renderPage();

    await screen.findByText("enable_telemedicine");
    expect(
      screen.queryByText(/Manage dynamic feature rollout across the platform/i),
    ).not.toBeInTheDocument();
  });

  it("says how many flags gate nothing, in the server's own words", async () => {
    primeList([INERT_FLAG, GATED_FLAG]);
    renderPage();

    expect(
      await screen.findByText(/1 of 2 flags gate nothing/i),
    ).toBeInTheDocument();
    expect(screen.getByText(INERT_NOTE)).toBeInTheDocument();
  });

  it("labels an inert row 'Gates nothing' and its control as a stored value", async () => {
    primeList([INERT_FLAG]);
    renderPage();

    await screen.findByText("enable_telemedicine");
    expect(screen.getByText("Gates nothing")).toBeInTheDocument();
    // The stored value is still shown — it is a record, not a switch position.
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Store as off/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Turn off$/i }),
    ).not.toBeInTheDocument();
  });

  it("tells the operator the toggle changed nothing at runtime", async () => {
    primeList([INERT_FLAG]);
    renderPage();

    await screen.findByText("enable_telemedicine");
    fireEvent.click(screen.getByRole("button", { name: /Store as off/i }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Stored value updated for "enable_telemedicine" — no runtime behaviour changed',
      ),
    );
    expect(toast.success).not.toHaveBeenCalledWith("Flag toggled");
    // The stored value is still written — this page reports, it does not veto.
    expect(fetchAdminAPIMock).toHaveBeenCalledWith("/admin/feature-flags", {
      method: "POST",
      body: {
        name: "enable_telemedicine",
        enabled: false,
        description: "Legacy record",
      },
    });
  });

  it("calls a wired flag what it is, and turns it on and off", async () => {
    primeList([GATED_FLAG]);
    renderPage();

    await screen.findByText("wired_example");
    expect(screen.getByText("Gates a code path")).toBeInTheDocument();
    expect(screen.queryByText(/gate nothing/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Turn off/i }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('"wired_example" is now off'),
    );
  });

  it("refuses to guess when the server reports no runtime effect", async () => {
    primeList([SILENT_FLAG]);
    renderPage();

    await screen.findByText("old_backend_flag");
    expect(screen.getByText("Not reported")).toBeInTheDocument();
    expect(screen.queryByText("Gates nothing")).not.toBeInTheDocument();
    expect(screen.queryByText("Gates a code path")).not.toBeInTheDocument();
    expect(
      screen.getByText(/did not report a runtime effect for 1 flag/i),
    ).toBeInTheDocument();
  });
});
