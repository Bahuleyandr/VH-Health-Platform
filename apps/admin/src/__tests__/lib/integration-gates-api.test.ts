// Integrations & Gates API client contract: the read hits the new
// SUPER_ADMIN endpoint, the mutations hit the PRE-EXISTING endpoints, and a
// tenant flag flip merges the FULL current settings (stripping the
// server-reserved governed keys) instead of clobbering sibling gate flags.

import { fetchAdminAPI } from "@/lib/api/core";
import {
  getIntegrationGates,
  registerSmsTemplate,
  setTenantGateFlag,
  upsertPaymentGatewayConfig,
  upsertSmsConfig,
} from "@/lib/api/integrationGates";
import { listTenants, updateTenant } from "@/lib/api/tenants";

jest.mock("@/lib/api/core", () => ({ fetchAdminAPI: jest.fn() }));
jest.mock("@/lib/api/tenants", () => ({
  listTenants: jest.fn(),
  updateTenant: jest.fn(),
}));

const fetchAdminAPIMock = fetchAdminAPI as jest.Mock;
const listTenantsMock = listTenants as jest.Mock;
const updateTenantMock = updateTenant as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("console read", () => {
  it("reads the SUPER_ADMIN gates endpoint, optionally tenant-filtered", async () => {
    fetchAdminAPIMock.mockResolvedValue({ env: {}, tenants: [] });
    await getIntegrationGates();
    expect(fetchAdminAPIMock).toHaveBeenCalledWith("/admin/integration-gates");

    await getIntegrationGates("33333333-3333-4333-8333-333333333333");
    expect(fetchAdminAPIMock).toHaveBeenCalledWith(
      "/admin/integration-gates?tenantId=33333333-3333-4333-8333-333333333333",
    );
  });
});

describe("tenant gate flag flip (settings PATCH is a full replace)", () => {
  const TENANT = {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "vh-main",
    name: "VH Main",
    region: "IN",
    compliance_profile: "DPDP",
    status: "active",
    settings: {
      branding: { name: "VH" },
      sms: { enabled: true },
      paymentGateway: { enabled: false },
      ambulanceGpsTracking: { enabled: false, retentionDays: 14 },
      // Server-reserved governed keys the generic PATCH must never carry:
      care_pathways: { locked: true },
      care_team_enforcement_mode: "shadow",
    },
    created_at: "",
    updated_at: "",
  };

  it("merges the flag into the FULL current settings and strips reserved keys", async () => {
    listTenantsMock.mockResolvedValue({ tenants: [TENANT], count: 1 });
    updateTenantMock.mockResolvedValue(TENANT);

    await setTenantGateFlag(TENANT.id, "paymentGateway", true);

    expect(updateTenantMock).toHaveBeenCalledWith(TENANT.id, {
      settings: {
        branding: { name: "VH" },
        sms: { enabled: true },
        paymentGateway: { enabled: true },
        ambulanceGpsTracking: { enabled: false, retentionDays: 14 },
      },
    });
    const sent = updateTenantMock.mock.calls[0][1].settings;
    expect(sent).not.toHaveProperty("care_pathways");
    expect(sent).not.toHaveProperty("care_team_enforcement_mode");
  });

  it("preserves sibling keys inside the gate object it toggles", async () => {
    listTenantsMock.mockResolvedValue({ tenants: [TENANT], count: 1 });
    updateTenantMock.mockResolvedValue(TENANT);

    await setTenantGateFlag(TENANT.id, "ambulanceGpsTracking", true);

    const sent = updateTenantMock.mock.calls[0][1].settings;
    expect(sent.ambulanceGpsTracking).toEqual({
      enabled: true,
      retentionDays: 14,
    });
  });

  it("creates the facilityAssets gate object when the tenant has none yet", async () => {
    listTenantsMock.mockResolvedValue({ tenants: [TENANT], count: 1 });
    updateTenantMock.mockResolvedValue(TENANT);

    await setTenantGateFlag(TENANT.id, "facilityAssets", true);

    const sent = updateTenantMock.mock.calls[0][1].settings;
    expect(sent.facilityAssets).toEqual({ enabled: true });
    expect(sent.sms).toEqual({ enabled: true }); // siblings untouched
  });

  it("flips the analyticsBi gate flag through the same settings merge (wt/bi-app)", async () => {
    listTenantsMock.mockResolvedValue({ tenants: [TENANT], count: 1 });
    updateTenantMock.mockResolvedValue(TENANT);

    await setTenantGateFlag(TENANT.id, "analyticsBi", true);

    const sent = updateTenantMock.mock.calls[0][1].settings;
    expect(sent.analyticsBi).toEqual({ enabled: true });
    // Sibling gate flags survive the full-replace PATCH untouched.
    expect(sent.sms).toEqual({ enabled: true });
    expect(sent).not.toHaveProperty("care_pathways");
  });

  it("throws instead of writing when the tenant is unknown", async () => {
    listTenantsMock.mockResolvedValue({ tenants: [], count: 0 });
    await expect(setTenantGateFlag(TENANT.id, "sms", true)).rejects.toThrow(
      "Tenant not found",
    );
    expect(updateTenantMock).not.toHaveBeenCalled();
  });
});

describe("provider-config mutations reuse the existing endpoints", () => {
  it("PUTs the payment gateway config to /billing/gateway/config", async () => {
    fetchAdminAPIMock.mockResolvedValue({ id: 1 });
    await upsertPaymentGatewayConfig({
      provider: "razorpay",
      environment: "sandbox",
      enabled: true,
      key_id: "rzp_test_x",
      key_secret: "write-only-secret",
      webhook_secret: "write-only-webhook",
    });
    expect(fetchAdminAPIMock).toHaveBeenCalledWith("/billing/gateway/config", {
      method: "PUT",
      body: expect.objectContaining({ provider: "razorpay", enabled: true }),
    });
  });

  it("PUTs the SMS config and POSTs DLT template registrations", async () => {
    fetchAdminAPIMock.mockResolvedValue({ id: 1 });
    await upsertSmsConfig({
      provider: "msg91",
      enabled: true,
      sender_id: "VHHOSP",
    });
    expect(fetchAdminAPIMock).toHaveBeenCalledWith(
      "/admin/notifications/sms/config",
      { method: "PUT", body: expect.objectContaining({ provider: "msg91" }) },
    );

    await registerSmsTemplate({
      template_key: "appointment_reminder",
      dlt_template_id: "1107ABC",
    });
    expect(fetchAdminAPIMock).toHaveBeenCalledWith(
      "/admin/notifications/sms/templates",
      {
        method: "POST",
        body: expect.objectContaining({ template_key: "appointment_reminder" }),
      },
    );
  });
});
