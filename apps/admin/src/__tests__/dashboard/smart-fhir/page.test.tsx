import SmartFhirPage from "@/app/(with-auth)/dashboard/smart-fhir/page";
import {
  listSmartApps,
  listSmartTokens,
  registerSmartApp,
  revokeSmartToken,
  type SmartAccessToken,
  type SmartApp,
} from "@/lib/api/smartFhir";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/smartFhir", () => {
  const actual = jest.requireActual("@/lib/api/smartFhir");
  return {
    ...actual,
    listSmartApps: jest.fn(),
    listSmartTokens: jest.fn(),
    registerSmartApp: jest.fn(),
    revokeSmartToken: jest.fn(),
  };
});

const mockListApps = listSmartApps as jest.MockedFunction<typeof listSmartApps>;
const mockListTokens = listSmartTokens as jest.MockedFunction<
  typeof listSmartTokens
>;
const mockRevoke = revokeSmartToken as jest.MockedFunction<
  typeof revokeSmartToken
>;

const app: SmartApp = {
  id: 3,
  tenant_id: "11111111-1111-4111-8111-111111111111",
  client_id: "cardio-viewer",
  display_name: "Cardio Viewer",
  description: "Reads observations",
  app_kind: "confidential",
  redirect_uris: ["https://cardio.example.com/callback"],
  allowed_scopes: ["patient/Observation.read", "launch/patient"],
  launch_uri: null,
  jwks_url: null,
  fhir_version: "R4",
  status: "active",
  environment: "sandbox",
  registration_status: "sandbox_approved",
  approved_by: null,
  approved_at: "2026-08-01T10:00:00.000Z",
  production_contract_ref: null,
  approval_notes: null,
  metadata: {},
  created_by: null,
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-01T10:00:00.000Z",
};

const activeToken: SmartAccessToken = {
  id: 17,
  tenant_id: app.tenant_id,
  smart_app_id: 3,
  granted_scopes: ["patient/Observation.read"],
  status: "active",
  issued_at: "2026-08-20T09:00:00.000Z",
  access_expires_at: "2026-08-20T10:00:00.000Z",
  refresh_expires_at: null,
  last_used_at: null,
  last_used_ip: null,
  environment: "sandbox",
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SmartFhirPage />
    </QueryClientProvider>,
  );
}

describe("<SmartFhirPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListApps.mockResolvedValue({ apps: [app], count: 1 });
    mockListTokens.mockResolvedValue({ tokens: [activeToken], count: 1 });
  });

  it("renders the registry, the token list, and the live public-surface note", async () => {
    renderPage();

    // client_id shows in the apps table, the token-panel app filter, and
    // the token row's app column.
    expect((await screen.findAllByText("cardio-viewer")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("Cardio Viewer")).toBeInTheDocument();
    expect(screen.getByText("/api/v1/fhir")).toBeInTheDocument();
    // token row (id + app label via client_id)
    expect(await screen.findByText("17")).toBeInTheDocument();
    expect(
      screen.getAllByText("patient/Observation.read").length,
    ).toBeGreaterThan(0);
    expect(mockListApps).toHaveBeenCalledTimes(1);
    expect(mockListTokens).toHaveBeenCalledWith({
      smartAppId: undefined,
      status: undefined,
      limit: 200,
    });
  });

  it("revokes a token only after the confirm dialog gets a reason", async () => {
    mockRevoke.mockResolvedValue({
      id: 17,
      status: "revoked",
      revoked_at: "2026-08-23T08:00:00.000Z",
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    // Dialog is up; nothing has been revoked yet and the confirm button
    // is disabled until a reason is entered.
    const confirmButton = screen.getByRole("button", { name: "Revoke token" });
    expect(confirmButton).toBeDisabled();
    expect(mockRevoke).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Revocation reason/), {
      target: { value: "credential compromised" },
    });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(mockRevoke).toHaveBeenCalledWith(17, "credential compromised"),
    );
    expect(mockRevoke).toHaveBeenCalledTimes(1);
  });

  it("cancelling the dialog never calls revoke", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.change(screen.getByLabelText(/Revocation reason/), {
      target: { value: "typo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockRevoke).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Revoke token" }),
    ).not.toBeInTheDocument();
  });

  it("shows empty states without any registered apps or tokens", async () => {
    mockListApps.mockResolvedValue({ apps: [], count: 0 });
    mockListTokens.mockResolvedValue({ tokens: [], count: 0 });
    renderPage();

    expect(
      await screen.findByText("No SMART apps registered"),
    ).toBeInTheDocument();
    expect(await screen.findByText("No access tokens")).toBeInTheDocument();
    expect(registerSmartApp).not.toHaveBeenCalled();
  });
});
