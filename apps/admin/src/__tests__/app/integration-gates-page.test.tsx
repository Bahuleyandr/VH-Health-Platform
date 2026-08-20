// Integrations & Gates page basics: the SUPER_ADMIN client gate, the gate
// table rendering with effective/blocking-layer states, and the write-only
// secret inputs (never prefilled from stored config).

import IntegrationGatesPage from "@/app/(with-auth)/dashboard/integration-gates/page";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";

let allowed = true;

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
  allowed = true;
});

describe("access gate", () => {
  it("shows the SUPER_ADMIN-only notice to a non-super role", () => {
    allowed = false;
    renderPage();
    expect(screen.getByText(/SUPER_ADMIN-only console/i)).toBeInTheDocument();
    expect(screen.queryByText(/Deployment environment switches/)).toBeNull();
  });
});

describe("gate table", () => {
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
