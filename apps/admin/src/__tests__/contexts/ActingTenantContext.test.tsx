import { ActingTenantBanner } from "@/components/ActingTenantBanner";
import {
  ActingTenantProvider,
  useActingTenant,
} from "@/contexts/ActingTenantContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

const TENANT = "a5a5a5a5-c5c5-4a5a-8a5a-a5a5c5c5aa01";
let clients: QueryClient[];

jest.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { uid: "admin-1", id: 1, role: "SUPER_ADMIN" },
    loading: false,
    sessionRevision: 1,
    isSessionCurrent: (revision: number) => revision === 1,
  }),
}));

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(qc);
  return render(
    <QueryClientProvider client={qc}>
      <ActingTenantProvider>{ui}</ActingTenantProvider>
    </QueryClientProvider>,
  );
}

function ActingTenantProbe() {
  const { actingTenant, setActAs, clear, isReady } = useActingTenant();
  return (
    <>
      <span>{isReady ? (actingTenant?.id ?? "none") : "resolving"}</span>
      <button
        type="button"
        disabled={!isReady}
        onClick={() => {
          void setActAs({ tenantId: TENANT, reason: "support" });
        }}
      >
        Begin acting
      </button>
      <button
        type="button"
        disabled={!isReady}
        onClick={() => {
          void clear().catch(() => {});
        }}
      >
        Stop acting
      </button>
    </>
  );
}

describe("ActingTenant banner + context (W5 S3)", () => {
  beforeEach(() => {
    clients = [];
  });
  afterEach(async () => {
    cleanup();
    await Promise.all(clients.map((client) => client.cancelQueries()));
    clients.forEach((client) => client.clear());
    jest.restoreAllMocks();
  });

  it("shows the banner when acting as a tenant", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        actingTenant: { id: TENANT, slug: "hosp-a", reason: "support" },
      }),
    } as Response);
    renderWithQuery(<ActingTenantBanner />);
    await waitFor(() =>
      expect(screen.getByText(/Acting as tenant/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("hosp-a")).toBeInTheDocument();
  });

  it("renders nothing when not acting (NO-OP for normal use)", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ actingTenant: null }),
    } as Response);
    const { container } = renderWithQuery(
      <>
        <ActingTenantBanner />
        <ActingTenantProbe />
      </>,
    );
    await screen.findByText("none");
    expect(global.fetch).toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("Exit calls DELETE /api/act-as", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(async (_url, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "DELETE") {
          return {
            ok: true,
            json: async () => ({ actingTenant: null }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            actingTenant: { id: TENANT, slug: "hosp-a", reason: "support" },
          }),
        } as Response;
      });
    renderWithQuery(<ActingTenantBanner />);
    await waitFor(() => expect(screen.getByText("hosp-a")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /exit tenant/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/act-as",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("publishes the mutation scope before tenant queries refetch", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(async (_url, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST") {
          return {
            ok: true,
            json: async () => ({
              actingTenant: { id: TENANT, slug: "hosp-a", reason: "support" },
            }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({ actingTenant: null }),
        } as Response;
      });

    renderWithQuery(<ActingTenantProbe />);
    await screen.findByText("none");
    await userEvent.click(screen.getByRole("button", { name: "Begin acting" }));

    await screen.findByText(TENANT);
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => (init?.method ?? "GET").toUpperCase() === "GET",
      ),
    ).toHaveLength(1);
  });

  it("keeps the acting scope when the clear request fails", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(async (_url, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "DELETE") {
          return {
            ok: false,
            json: async () => ({ message: "Clear rejected" }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            actingTenant: { id: TENANT, slug: "hosp-a", reason: "support" },
          }),
        } as Response;
      });

    renderWithQuery(<ActingTenantProbe />);
    await screen.findByText(TENANT);
    await userEvent.click(screen.getByRole("button", { name: "Stop acting" }));

    await waitFor(() => expect(screen.getByText(TENANT)).toBeInTheDocument());
    expect(
      fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET"),
    ).toEqual(["GET", "DELETE", "GET"]);
  });
});
