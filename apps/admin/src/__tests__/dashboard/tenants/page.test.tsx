import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TenantsAdminPage from "@/app/(with-auth)/dashboard/tenants/page";
import {
  createTenant,
  getTenantKekRewrapJob,
  listTenantInteropSecrets,
  listTenants,
  startTenantKekRewrapJob,
  updateTenant,
  updateTenantBrandKit,
  upsertTenantInteropSecret,
} from "@/lib/api/tenants";
import { usePermissions } from "@/hooks/usePermissions";
import { useActingTenant } from "@/contexts/ActingTenantContext";

jest.mock("@/lib/api/tenants", () => ({
  createTenant: jest.fn(),
  getTenantKekRewrapJob: jest.fn(),
  listTenantInteropSecrets: jest.fn(),
  listTenants: jest.fn(),
  startTenantKekRewrapJob: jest.fn(),
  updateTenant: jest.fn(),
  updateTenantBrandKit: jest.fn(),
  upsertTenantInteropSecret: jest.fn(),
}));

jest.mock("@/hooks/usePermissions", () => ({ usePermissions: jest.fn() }));
jest.mock("@/contexts/ActingTenantContext", () => ({ useActingTenant: jest.fn() }));
jest.mock("react-hot-toast", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const TENANT = {
  id: "35353535-3535-4353-8535-353535353503",
  slug: "acme",
  name: "Acme Hospital",
  region: "IN",
  compliance_profile: "DPDP",
  status: "active",
  settings: {
    branding: {
      name: "Acme Care",
      primaryColor: "#007A64",
      supportEmail: "support@acme.example",
      helpCenterUrl: "https://help.acme.example",
      assets: { logo: { storageKey: "uploads/admin/logo.png" } },
      document: { footerText: "Acme legal footer" },
      email: { fromName: "Acme Care", replyTo: "support@acme.example" },
    },
  },
  created_at: "2026-07-03T07:00:00.000Z",
  updated_at: "2026-07-03T07:00:00.000Z",
};

function setPermissions() {
  (usePermissions as jest.Mock).mockReturnValue({
    user: { role: "SUPER_ADMIN" },
    role: "SUPER_ADMIN",
    permissions: ["*"],
    isSuperAdmin: true,
    isAdmin: true,
    isHR: false,
    isDoctor: false,
    isStaff: false,
    isHROrAbove: true,
    isStaffOrAbove: true,
    loading: false,
    hasPermission: () => true,
    hasAnyPermission: () => true,
    hasAllPermissions: () => true,
    allowed: true,
    roleAllowed: true,
    permsAllowed: true,
  } as unknown as ReturnType<typeof usePermissions>);
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TenantsAdminPage />
    </QueryClientProvider>,
  );
}

describe("<TenantsAdminPage /> tenant operations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setPermissions();
    (useActingTenant as jest.Mock).mockReturnValue({
      actingTenant: null,
      isPending: false,
      setActAs: jest.fn(),
    });
    (listTenants as jest.Mock).mockResolvedValue({ tenants: [TENANT], count: 1 });
    (listTenantInteropSecrets as jest.Mock).mockResolvedValue({
      count: 1,
      secrets: [{
        id: 7,
        tenant_id: TENANT.id,
        kind: "abdm_callback",
        sender_identifier: "HIP-ACME",
        status: "active",
        has_secret: true,
        secret_masked: "********",
        created_at: "2026-07-03T07:00:00.000Z",
        updated_at: "2026-07-03T07:05:00.000Z",
      }],
    });
    (upsertTenantInteropSecret as jest.Mock).mockResolvedValue({
      id: 8,
      tenant_id: TENANT.id,
      kind: "hl7_inbound",
      sender_identifier: "MSH-ACME",
      status: "active",
      has_secret: true,
      secret_masked: "********",
      created_at: "2026-07-03T07:10:00.000Z",
      updated_at: "2026-07-03T07:10:00.000Z",
    });
    (startTenantKekRewrapJob as jest.Mock).mockResolvedValue({
      job_id: "job-123",
      tenant_id: TENANT.id,
      status: "queued",
      requested_by: "super",
      created_at: "2026-07-03T07:15:00.000Z",
      started_at: null,
      completed_at: null,
      updated_at: "2026-07-03T07:15:00.000Z",
      summary: null,
      error: null,
    });
    (getTenantKekRewrapJob as jest.Mock).mockResolvedValue({
      job_id: "job-123",
      tenant_id: TENANT.id,
      status: "succeeded",
      requested_by: "super",
      created_at: "2026-07-03T07:15:00.000Z",
      started_at: "2026-07-03T07:15:01.000Z",
      completed_at: "2026-07-03T07:15:02.000Z",
      updated_at: "2026-07-03T07:15:02.000Z",
      summary: { tenant_id: TENANT.id, key_id: "t:tenant:v1", dry_run: false, scanned: 1, rewrapped: 1, tables: [] },
      error: null,
    });
    (createTenant as jest.Mock).mockResolvedValue(TENANT);
    (updateTenant as jest.Mock).mockResolvedValue(TENANT);
    (updateTenantBrandKit as jest.Mock).mockResolvedValue({
      brandKit: {
        schemaVersion: 1,
        name: "Acme Care",
        primaryColor: "#007A64",
        logoUrl: null,
        supportEmail: "support@acme.example",
        legalName: null,
        legalFooter: null,
        helpCenterUrl: "https://help.acme.example",
        document: { legalName: null, footerText: "Acme legal footer", letterheadUrl: null },
        email: { fromName: "Acme Care", replyTo: "support@acme.example" },
        assets: { logo: null, documentLetterhead: null },
        mobile: { identityMode: "stamped_build", tokenColorSource: "VH_TENANT_PRIMARY" },
      },
    });
  });

  it("renders masked interop secrets and stores new values without echoing plaintext", async () => {
    renderPage();
    await screen.findByText("Acme Hospital");
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));

    await screen.findByText("HIP-ACME");
    expect(screen.getByText("********")).toBeInTheDocument();
    expect(screen.queryByText("secret-value")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Interop kind"), { target: { value: "hl7_inbound" } });
    fireEvent.change(screen.getByLabelText("Sender identifier"), { target: { value: "MSH-ACME" } });
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: "secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: /Store/ }));

    await waitFor(() => expect(upsertTenantInteropSecret).toHaveBeenCalledWith(TENANT.id, {
      kind: "hl7_inbound",
      senderIdentifier: "MSH-ACME",
      secret: "secret-value",
    }));
    expect(screen.queryByText("secret-value")).not.toBeInTheDocument();
  });

  it("queues a tenant KEK re-wrap job from the details panel", async () => {
    renderPage();
    await screen.findByText("Acme Hospital");
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));

    fireEvent.click(await screen.findByRole("button", { name: /Queue re-wrap/ }));

    await waitFor(() => expect(startTenantKekRewrapJob).toHaveBeenCalledWith(TENANT.id));
    await screen.findByText("job-123");
  });

  it("saves the brand kit through the dedicated brand endpoint", async () => {
    renderPage();
    await screen.findByText("Acme Hospital");
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));

    fireEvent.change(await screen.findByLabelText("Brand name"), { target: { value: "Acme White Label" } });
    fireEvent.change(screen.getByLabelText("Primary color"), { target: { value: "#005A4A" } });
    fireEvent.change(screen.getByLabelText("Logo storage key"), { target: { value: "uploads/admin/new-logo.png" } });
    fireEvent.click(screen.getByRole("button", { name: /Save brand kit/ }));

    await waitFor(() => expect(updateTenantBrandKit).toHaveBeenCalledWith(TENANT.id, expect.objectContaining({
      name: "Acme White Label",
      primaryColor: "#005A4A",
      assets: expect.objectContaining({
        logo: { storageKey: "uploads/admin/new-logo.png" },
      }),
    })));
  });
});
