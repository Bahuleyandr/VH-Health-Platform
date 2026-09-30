// Integrations & Gates page basics: the SUPER_ADMIN client gate, the gate
// table rendering with effective/blocking-layer states, and the write-only
// secret inputs (never prefilled from stored config).

import IntegrationGatesPage from "@/app/(with-auth)/dashboard/integration-gates/page";
import {
  getIntegrationGates,
  listSmsTemplates,
  upsertPaymentGatewayConfig,
} from "@/lib/api/integrationGates";
import { listTenants, updateTenant } from "@/lib/api/tenants";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

jest.mock("@/lib/api/tenants", () => ({
  listTenants: jest.fn(),
  updateTenant: jest.fn(),
}));

let allowed = true;
let scopeReady = true;
let scopeKey = "session-a:tenant-a";
let scopeError: Error | null = null;
const retryScope = jest.fn().mockResolvedValue(undefined);

jest.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ allowed }),
}));

jest.mock("@/contexts/ActingTenantContext", () => ({
  useActingTenant: () => ({
    actingTenant: {
      id: "33333333-3333-4333-8333-333333333333",
      slug: "vh-main",
      reason: "ops",
    },
    setActAs: jest.fn(),
    clear: jest.fn(),
    isPending: false,
    isReady: scopeReady,
    scopeKey: scopeReady ? scopeKey : null,
    isScopeCurrent: (captured: string) => scopeReady && captured === scopeKey,
    error: scopeError,
    retry: retryScope,
  }),
}));

const REPORT = {
  generated_at: "2026-08-18T00:00:00.000Z",
  env: {
    payment_gateway_enabled: true,
    sms_provider: "logger",
    sms_kill_switch: true,
    abdm_enabled: false,
    abdm_environment: "sandbox",
    abdm_has_client_credentials: false,
    uhi_enabled: false,
    uhi_environment: "sandbox",
    uhi_has_subscriber_identity: false,
    facility_assets_enabled: false,
    livekit_enabled: false,
    file_scan_policy: "required",
    clinical_continuity_c_d14_approved: false,
    metabase_configured: false,
    metabase_dashboards_configured: 0,
  },
  tenants: [
    {
      tenant: {
        id: "33333333-3333-4333-8333-333333333333",
        slug: "vh-main",
        name: "VH Main",
        status: "active",
      },
      gates: {
        payment_gateway: {
          effective: true,
          blocking_layer: null,
          reason: null,
          layers: {
            env: true,
            tenant_setting: true,
            provider_configs: [
              {
                id: 1,
                provider: "razorpay",
                environment: "sandbox",
                enabled: true,
                display_name: null,
                key_id: "rzp_test_x",
                accepted_methods: ["upi"],
                has_key_secret: true,
                has_webhook_secret: true,
                webhook_path: "/webhooks/payments/tok",
                created_at: "",
                updated_at: "",
              },
            ],
          },
        },
        sms: {
          effective: false,
          blocking_layer: "env",
          reason: "env_kill_switch",
          provider: "dry_run",
          layers: {
            env_provider: "logger",
            env_kill_switch: true,
            tenant_setting: false,
            provider_configs: [],
          },
          dlt_templates: { total: 0, active: 0 },
        },
        abdm_enrolment: {
          effective: false,
          blocking_layer: "env",
          layers: { env: false, tenant_setting: false },
        },
        abdm_scan_share: {
          effective: false,
          blocking_layer: "env",
          rides: "abdm_enrolment",
        },
        abdm_hiu: {
          effective: false,
          blocking_layer: "env",
          layers: { env: false, tenant_setting: false },
        },
        uhi: {
          effective: false,
          blocking_layer: "env",
          layers: { env: false, tenant_setting: false },
          environment: "sandbox",
        },
        ambulance_gps: {
          effective: false,
          blocking_layer: "tenant_setting",
          layers: { tenant_setting: false },
          retention_days: 7,
          min_seconds_between_fixes: 3,
        },
        facility_assets: {
          effective: false,
          blocking_layer: "env",
          layers: { env: false, tenant_setting: false },
        },
        analytics_bi: {
          effective: false,
          blocking_layer: "env",
          layers: { env: false, tenant_setting: false },
        },
      },
    },
  ],
};

jest.mock("@/lib/api/integrationGates", () => {
  const actual = jest.requireActual("@/lib/api/integrationGates");
  return {
    ...actual,
    getIntegrationGates: jest.fn(() => Promise.resolve(REPORT)),
    listSmsTemplates: jest.fn(() => Promise.resolve({ templates: [] })),
    upsertPaymentGatewayConfig: jest.fn(),
  };
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <IntegrationGatesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  allowed = true;
  scopeReady = true;
  scopeKey = "session-a:tenant-a";
  scopeError = null;
});

describe("access gate", () => {
  it.each(["loading", "error"])(
    "does not fetch or show provider forms while scope is %s",
    (state) => {
      scopeReady = false;
      scopeError = state === "error" ? new Error("scope unavailable") : null;
      renderPage();
      expect(getIntegrationGates).not.toHaveBeenCalled();
      expect(listSmsTemplates).not.toHaveBeenCalled();
      expect(screen.queryByText("Provider configuration")).toBeNull();
      if (scopeError) {
        fireEvent.click(
          screen.getByRole("button", { name: "Retry tenant scope" }),
        );
        expect(retryScope).toHaveBeenCalledTimes(1);
      } else {
        expect(
          screen.getByText("Confirming tenant scope…"),
        ).toBeInTheDocument();
      }
    },
  );
  it("shows the SUPER_ADMIN-only notice to a non-super role", () => {
    allowed = false;
    renderPage();
    expect(screen.getByText(/SUPER_ADMIN-only console/i)).toBeInTheDocument();
    expect(screen.queryByText(/Deployment environment switches/)).toBeNull();
  });
});

describe("gate table", () => {
  it("does not PATCH a gate after the scope changes during its settings read", async () => {
    let finish!: (value: unknown) => void;
    (listTenants as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const page = () => (
      <QueryClientProvider client={client}>
        <IntegrationGatesPage />
      </QueryClientProvider>
    );
    const view = render(page());
    const gate = (await screen.findByText("Facility asset register")).closest(
      "tr",
    )!;
    fireEvent.click(within(gate).getByRole("button"));
    await waitFor(() => expect(listTenants).toHaveBeenCalledTimes(1));
    scopeReady = false;
    view.rerender(page());
    await act(async () => {
      finish({
        tenants: [{ ...REPORT.tenants[0].tenant, settings: {} }],
        count: 1,
      });
    });
    expect(updateTenant).not.toHaveBeenCalled();
  });

  it("does not cache a late report under a scope that is no longer current", async () => {
    let finish!: (value: unknown) => void;
    (getIntegrationGates as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const page = () => (
      <QueryClientProvider client={client}>
        <IntegrationGatesPage />
      </QueryClientProvider>
    );
    const view = render(page());
    await waitFor(() => expect(getIntegrationGates).toHaveBeenCalledTimes(1));
    scopeReady = false;
    view.rerender(page());
    await act(async () => {
      finish(REPORT);
    });
    expect(
      client.getQueryData(["integration-gates", "session-a:tenant-a"]),
    ).toBeUndefined();
  });

  it("does not cache late SMS templates under a scope that is no longer current", async () => {
    let finish!: (value: unknown) => void;
    (listSmsTemplates as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const page = () => (
      <QueryClientProvider client={client}>
        <IntegrationGatesPage />
      </QueryClientProvider>
    );
    const view = render(page());
    await waitFor(() => expect(listSmsTemplates).toHaveBeenCalledTimes(1));
    scopeReady = false;
    view.rerender(page());
    await act(async () => {
      finish({ templates: [{ id: "wrong-scope" }] });
    });
    expect(
      client.getQueryData([
        "integration-gates",
        "session-a:tenant-a",
        "sms-templates",
      ]),
    ).toBeUndefined();
  });

  it("resets secret drafts and isolates report/template caches on scope changes", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const page = () => (
      <QueryClientProvider client={client}>
        <IntegrationGatesPage />
      </QueryClientProvider>
    );
    const view = render(page());
    await screen.findByLabelText("Key secret");
    fireEvent.change(screen.getByLabelText("Key secret"), {
      target: { value: "synthetic-old-scope-secret" },
    });
    scopeReady = false;
    view.rerender(page());
    expect(screen.queryByLabelText("Key secret")).toBeNull();
    scopeKey = "session-b:tenant-a";
    scopeReady = true;
    view.rerender(page());
    expect(await screen.findByLabelText("Key secret")).toHaveValue("");
    await waitFor(() => expect(listSmsTemplates).toHaveBeenCalledTimes(2));
    expect(
      client.getQueryData(["integration-gates", "session-b:tenant-a"]),
    ).toEqual(REPORT);
    expect(
      client.getQueryData([
        "integration-gates",
        "session-b:tenant-a",
        "sms-templates",
      ]),
    ).toEqual({ templates: [] });
  });

  it("ignores a gateway completion after its scope was unmounted", async () => {
    let finish!: (value: unknown) => void;
    (upsertPaymentGatewayConfig as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const page = () => (
      <QueryClientProvider client={client}>
        <IntegrationGatesPage />
      </QueryClientProvider>
    );
    const view = render(page());
    fireEvent.click(
      await screen.findByRole("button", { name: "Save gateway config" }),
    );
    await waitFor(() =>
      expect(upsertPaymentGatewayConfig).toHaveBeenCalledTimes(1),
    );
    scopeReady = false;
    view.rerender(page());
    await act(async () => {
      finish({ webhook_path: null });
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Key secret")).toBeNull();
  });

  it("renders env facts, per-tenant gates with effective state and blocking layer", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("VH Main")).toBeInTheDocument(),
    );
    // Env facts card
    expect(
      screen.getByText(/Deployment environment switches/),
    ).toBeInTheDocument();
    // Effective ON badge for payment gateway
    expect(screen.getAllByText("ON").length).toBeGreaterThan(0);
    // A dark gate names its blocking layer
    expect(screen.getAllByText(/off — env switch/).length).toBeGreaterThan(0);
    expect(screen.getByText(/off — tenant flag/)).toBeInTheDocument();
    // Scan & Share rides enrolment (no flag button of its own)
    expect(screen.getByText(/rides ABHA enrolment/)).toBeInTheDocument();
    // The facility asset register row is listed with its own tenant flag
    expect(screen.getByText("Facility asset register")).toBeInTheDocument();
    // Analytics BI (wt/bi-app) renders as a normal two-layer gate row with
    // its own tenant-flag toggle.
    expect(screen.getByText("Analytics BI embeds")).toBeInTheDocument();
    // And the env facts card carries the Metabase presence fact.
    expect(
      screen.getByText(/Metabase embeds \(METABASE_URL \+ secret\)/),
    ).toBeInTheDocument();
  });

  it("never prefills write-only secret inputs from stored config", async () => {
    const { container } = renderPage();
    await waitFor(() =>
      expect(screen.getByText("VH Main")).toBeInTheDocument(),
    );
    const secretInputs = container.querySelectorAll('input[type="password"]');
    expect(secretInputs.length).toBeGreaterThan(0);
    for (const input of Array.from(secretInputs)) {
      expect((input as HTMLInputElement).value).toBe("");
    }
    // The stored-secret presence is surfaced as text, not as a value.
    expect(screen.getAllByText(/one is stored/).length).toBeGreaterThan(0);
  });

  it("labels the acting tenant the provider-config forms write to", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/currently acting as/)).toBeInTheDocument(),
    );
    expect(screen.getByText("vh-main")).toBeInTheDocument();
  });
});
