import {
  ActingTenantProvider,
  useActingTenant,
} from "@/contexts/ActingTenantContext";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import * as apiClient from "@/lib/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const mockPush = jest.fn();
let drains: (() => void)[];
let pendingOperations: Promise<unknown>[];

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { error: jest.fn() },
}));
jest.mock("@/lib/api-client", () => ({
  adminLogin: jest.fn(),
  staffLogin: jest.fn(),
  adminLogout: jest.fn(),
  getAdminProfile: jest.fn(),
  getAdminUser: jest.fn(),
  clearAuthData: jest.fn(),
  verifyAdminMfa: jest.fn(),
  adminMfaSetupEnroll: jest.fn(),
  adminMfaSetupConfirm: jest.fn(),
}));

const user = {
  uid: "admin-1",
  id: 1,
  name: "Same Admin",
  email: "admin@example.com",
  phone: "0000000000",
  is_active: true,
  created_at: "2026-01-01",
  role: "ADMIN" as const,
  permissions: [],
};

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

type Auth = ReturnType<typeof useAuth>;
const operations: {
  name: string;
  mock: jest.Mock;
  run: (auth: Auth) => Promise<unknown>;
  response: unknown;
}[] = [
  {
    name: "profile check",
    mock: apiClient.getAdminProfile as jest.Mock,
    run: (auth) => auth.checkAuth(),
    response: user,
  },
  {
    name: "password login",
    mock: apiClient.adminLogin as jest.Mock,
    run: (auth) => auth.login("admin", "synthetic-password"),
    response: { admin: user },
  },
  {
    name: "MFA verification",
    mock: apiClient.verifyAdminMfa as jest.Mock,
    run: (auth) =>
      auth.verifyMfa({ challengeToken: "synthetic", code: "000000" }),
    response: { admin: user },
  },
  {
    name: "MFA setup confirmation",
    mock: apiClient.adminMfaSetupConfirm as jest.Mock,
    run: (auth) =>
      auth.mfaSetupConfirm({
        setupToken: "synthetic",
        code: "000000",
        encryptedSecret: "synthetic",
        backupCodes: [],
      }),
    response: { admin: user },
  },
  {
    name: "staff login",
    mock: apiClient.staffLogin as jest.Mock,
    run: (auth) => auth.loginStaff("synthetic-staff", "synthetic-password"),
    response: { user },
  },
  {
    name: "logout",
    mock: apiClient.adminLogout as jest.Mock,
    run: (auth) => auth.logout(),
    response: { serverSignOutOk: true },
  },
];

describe("AuthProvider observed session revision", () => {
  beforeEach(() => {
    drains = [];
    pendingOperations = [];
    jest.resetAllMocks();
    (apiClient.getAdminUser as jest.Mock).mockReturnValue(user);
    (apiClient.getAdminProfile as jest.Mock).mockResolvedValue(user);
  });

  it.each(operations)(
    "invalidates the old scope at the start of $name",
    async ({ mock, run, response, name }) => {
      const { result } = renderHook(useAuth, { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.sessionRevision).toBe(1);
      let resolve!: (value: unknown) => void;
      mock.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
            drains.push(() => done(response));
          }),
      );
      let pending!: Promise<unknown>;

      act(() => {
        pending = run(result.current);
        pendingOperations.push(pending.catch(() => undefined));
      });

      expect(result.current.loading).toBe(true);
      expect(result.current.sessionRevision).toBe(2);
      await act(async () => {
        resolve(response);
        await pending;
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.sessionRevision).toBe(2);
      expect(result.current.user?.uid ?? null).toBe(
        name === "logout" ? null : user.uid,
      );
    },
  );

  it.each(operations)(
    "does not restore the previous revision when $name fails",
    async ({ mock, run }) => {
      const { result } = renderHook(useAuth, { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));
      jest.spyOn(console, "warn").mockImplementation(() => {});
      mock.mockRejectedValueOnce(new Error("Synthetic authentication failure"));

      await act(async () => {
        await run(result.current).catch(() => undefined);
      });

      expect(result.current.sessionRevision).toBe(2);
      expect(result.current.loading).toBe(false);
    },
  );

  it("does not claim a session change when only preparing MFA enrollment", async () => {
    const { result } = renderHook(useAuth, { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    (apiClient.adminMfaSetupEnroll as jest.Mock).mockResolvedValue({
      backupCodes: [],
    });

    await act(async () => {
      await result.current.mfaSetupEnroll({ setupToken: "synthetic" });
    });

    expect(result.current.sessionRevision).toBe(1);
    expect(result.current.user?.uid).toBe(user.uid);
  });

  it.each(operations)(
    "invalidates a retained tenant scope synchronously when $name begins",
    async ({ mock, run, response }) => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ actingTenant: null }),
      } as Response);
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const { result, unmount } = renderHook(
        () => ({ auth: useAuth(), scope: useActingTenant() }),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>
              <AuthProvider>
                <ActingTenantProvider>{children}</ActingTenantProvider>
              </AuthProvider>
            </QueryClientProvider>
          ),
        },
      );
      await waitFor(() => expect(result.current.scope.isReady).toBe(true));
      const savedScope = result.current.scope;
      const key = savedScope.scopeKey!;
      mock.mockImplementationOnce(
        () =>
          new Promise((done) => {
            drains.push(() => done(response));
          }),
      );
      act(() => {
        pendingOperations.push(run(result.current.auth).catch(() => undefined));
        expect(savedScope.isScopeCurrent(key)).toBe(false);
      });
      unmount();
      client.clear();
    },
  );

  it.each(["POST", "DELETE"])(
    "does not send a queued %s after authentication renewal begins",
    async (method) => {
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ actingTenant: null }),
      } as Response);
      let beginRenewal = () => {};
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { onMutate: () => beginRenewal() },
        },
      });
      const { result, unmount } = renderHook(
        () => ({ auth: useAuth(), scope: useActingTenant() }),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>
              <AuthProvider>
                <ActingTenantProvider>{children}</ActingTenantProvider>
              </AuthProvider>
            </QueryClientProvider>
          ),
        },
      );
      await waitFor(() => expect(result.current.scope.isReady).toBe(true));
      (apiClient.getAdminProfile as jest.Mock).mockImplementationOnce(
        () =>
          new Promise((done) => {
            drains.push(() => done(user));
          }),
      );
      let mutation!: Promise<unknown>;
      beginRenewal = () => {
        pendingOperations.push(
          result.current.auth.checkAuth().catch(() => undefined),
        );
      };
      await act(async () => {
        mutation = (
          method === "POST"
            ? result.current.scope.setActAs({
                tenantId: "33333333-3333-4333-8333-333333333333",
                reason: "Synthetic support",
              })
            : result.current.scope.clear()
        ).catch((error: unknown) => error);
        await mutation;
      });
      expect(await mutation).toBeInstanceOf(Error);
      expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
        "GET",
      ]);
      unmount();
      client.clear();
    },
  );

  afterEach(async () => {
    cleanup();
    await act(async () => {
      drains.forEach((drain) => drain());
      await Promise.all(pendingOperations);
    });
    jest.restoreAllMocks();
  });
});
