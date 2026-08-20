// BI Dashboards page gating states (wt/bi-app): the analyticsBi gate from
// GET /dashboards/catalog renders a clear "not enabled"/"not configured"
// notice instead of dead cards or a broken iframe, ready cards open an embed,
// and per-dashboard embed failures map the backend's fail-closed codes.

import DashboardsPage from "@/app/(with-auth)/dashboard/dashboards/page";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api", () => {
  const actual = jest.requireActual("@/lib/api");
  return {
    ...actual,
    fetchAdminAPI: jest.fn(),
  };
});

import { APIError, fetchAdminAPI } from "@/lib/api";

const fetchAdminAPIMock = fetchAdminAPI as jest.Mock;

function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    key: "daily_ops",
    title: "Daily Operations Snapshot",
    description: "Executive huddle metrics",
    available: true,
    status: "active",
    certificationStatus: "certified",
    datasetKeys: ["fct_encounters"],
    requiredParams: ["tenant_id"],
    embedRoles: ["ADMIN", "SUPER_ADMIN"],
    ownerRole: "MEDICAL_SUPERINTENDENT",
    displayOrder: 10,
    ...overrides,
  };
}

function primeCatalog(
  analyticsBi: {
    envConfigured: boolean;
    tenantEnabled: boolean;
    effective: boolean;
  },
  embed?: () => Promise<unknown>,
) {
  fetchAdminAPIMock.mockImplementation((endpoint: string) => {
    if (endpoint === "/dashboards/catalog") {
      return Promise.resolve({
        datasets: [],
        dashboards: [dashboard()],
        analyticsBi,
      });
    }
    if (endpoint === "/dashboards/embed/url") {
      return embed
        ? embed()
        : Promise.resolve({
            url: "https://analytics.vhhealth.hospital.local/embed/dashboard/tok",
          });
    }
    return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DashboardsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchAdminAPIMock.mockReset();
});

describe("gate-off states", () => {
  it("tenant flag off: clear not-enabled notice, card disabled with Not enabled badge", async () => {
    primeCatalog({
      envConfigured: true,
      tenantEnabled: false,
      effective: false,
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Daily Operations Snapshot")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Analytics embedding is not enabled for this hospital/),
    ).toBeInTheDocument();
    expect(screen.getByText("Not enabled")).toBeInTheDocument();
    const card = screen
      .getByText("Daily Operations Snapshot")
      .closest("button")!;
    expect(card).toBeDisabled();
    // No embed request is ever fired while the gate is off.
    fireEvent.click(card);
    expect(fetchAdminAPIMock).not.toHaveBeenCalledWith(
      "/dashboards/embed/url",
      expect.anything(),
    );
  });

  it("env unconfigured: names the deployment-config state instead", async () => {
    primeCatalog({
      envConfigured: false,
      tenantEnabled: true,
      effective: false,
    });
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(
          /Metabase embedding is not configured for this deployment/,
        ),
      ).toBeInTheDocument(),
    );
  });
});

describe("gate-on embed flow", () => {
  it("opens a ready dashboard into a sandboxed iframe", async () => {
    primeCatalog({ envConfigured: true, tenantEnabled: true, effective: true });
    renderPage();

    await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
    fireEvent.click(
      screen.getByText("Daily Operations Snapshot").closest("button")!,
    );

    await waitFor(() =>
      expect(fetchAdminAPIMock).toHaveBeenCalledWith(
        "/dashboards/embed/url",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const iframe = await waitFor(() => {
      const el = document.querySelector("iframe");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(iframe.getAttribute("src")).toContain(
      "https://analytics.vhhealth.hospital.local/embed/dashboard/",
    );
    expect(iframe.getAttribute("sandbox")).toContain("allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain(
      "allow-top-navigation",
    );
  });

  it("maps a per-dashboard ANALYTICS_BI_TENANT_DISABLED failure into the viewer panel", async () => {
    primeCatalog(
      { envConfigured: true, tenantEnabled: true, effective: true },
      () =>
        Promise.reject(
          new APIError("Forbidden", 403, {
            success: false,
            message: "Analytics embedding is not enabled for this hospital",
            code: "ANALYTICS_BI_TENANT_DISABLED",
          }),
        ),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
    fireEvent.click(
      screen.getByText("Daily Operations Snapshot").closest("button")!,
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          /Analytics embedding is not enabled for this hospital\./,
        ),
      ).toBeInTheDocument(),
    );
    // The failure is scoped to the viewer panel, not a page-level banner.
    expect(document.querySelector("iframe")).toBeNull();
  });
});
