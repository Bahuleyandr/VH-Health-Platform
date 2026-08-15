/**
 * Regression tests: the middleware's post-login `?redirect=` deep link is
 * consumed by EVERY AuthContext success path (password login, MFA verify,
 * first-time MFA setup confirm, staff login) — with strict validation so a
 * hostile value can never become an open redirect.
 */

import { act, render, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import {
  adminLogin,
  adminMfaSetupConfirm,
  getAdminProfile,
  getAdminUser,
  staffLogin,
  verifyAdminMfa,
} from "@/lib/api-client";

const push = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
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

const admin = {
  uid: "admin-1",
  id: 1,
  name: "Admin",
  email: "admin@example.com",
  phone: "0000000000",
  is_active: true,
  created_at: "2026-01-01",
  role: "ADMIN",
  permissions: [],
};

const mockedAdminLogin = adminLogin as jest.MockedFunction<typeof adminLogin>;
const mockedStaffLogin = staffLogin as jest.MockedFunction<typeof staffLogin>;
const mockedVerifyMfa = verifyAdminMfa as jest.MockedFunction<
  typeof verifyAdminMfa
>;
const mockedMfaSetupConfirm = adminMfaSetupConfirm as jest.MockedFunction<
  typeof adminMfaSetupConfirm
>;
const mockedGetAdminProfile = getAdminProfile as jest.MockedFunction<
  typeof getAdminProfile
>;
const mockedGetAdminUser = getAdminUser as jest.MockedFunction<
  typeof getAdminUser
>;

type Auth = ReturnType<typeof useAuth>;

async function mountAuth(): Promise<() => Auth> {
  let latest: Auth | null = null;
  function Capture() {
    latest = useAuth();
    return null;
  }
  render(
    <AuthProvider>
      <Capture />
    </AuthProvider>,
  );
  await waitFor(() => expect(latest).not.toBeNull());
  // The initial checkAuth probe must settle before the assertions run.
  await waitFor(() => expect((latest as unknown as Auth).loading).toBe(false));
  return () => latest as unknown as Auth;
}

function setLoginUrl(search: string) {
  window.history.replaceState(null, "", `/login${search}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetAdminUser.mockReturnValue(null);
  mockedGetAdminProfile.mockRejectedValue(new Error("unauthenticated"));
  mockedAdminLogin.mockResolvedValue({
    admin,
  } as unknown as Awaited<ReturnType<typeof adminLogin>>);
  mockedStaffLogin.mockResolvedValue({
    user: admin,
  } as unknown as Awaited<ReturnType<typeof staffLogin>>);
  mockedVerifyMfa.mockResolvedValue({
    admin,
  } as unknown as Awaited<ReturnType<typeof verifyAdminMfa>>);
  mockedMfaSetupConfirm.mockResolvedValue({
    admin,
  } as unknown as Awaited<ReturnType<typeof adminMfaSetupConfirm>>);
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("post-login redirect consumption — valid deep link round-trips", () => {
  it("password login navigates to the ?redirect= dashboard path", async () => {
    setLoginUrl("?redirect=%2Fdashboard%2Fappointments");
    const auth = await mountAuth();
    await act(async () => {
      await auth().login("root", "secret");
    });
    expect(push).toHaveBeenCalledWith("/dashboard/appointments");
  });

  it("MFA verify navigates to the ?redirect= dashboard path", async () => {
    setLoginUrl("?redirect=%2Fdashboard%2Fsos");
    const auth = await mountAuth();
    await act(async () => {
      await auth().verifyMfa({ challengeToken: "c", code: "123456" });
    });
    expect(push).toHaveBeenCalledWith("/dashboard/sos");
  });

  it("first-time MFA setup confirm navigates to the ?redirect= dashboard path", async () => {
    setLoginUrl("?redirect=%2Fdashboard%2Fsettings");
    const auth = await mountAuth();
    await act(async () => {
      await auth().mfaSetupConfirm({
        setupToken: "s",
        code: "123456",
        encryptedSecret: "enc",
        backupCodes: ["a"],
      });
    });
    expect(push).toHaveBeenCalledWith("/dashboard/settings");
  });

  it("staff login navigates to the ?redirect= dashboard path", async () => {
    setLoginUrl("?redirect=%2Fdashboard%2Fappointments%3Ftab%3Dqueue");
    const auth = await mountAuth();
    await act(async () => {
      await auth().loginStaff("EMP001", "secret");
    });
    expect(push).toHaveBeenCalledWith("/dashboard/appointments?tab=queue");
  });
});

describe("post-login redirect consumption — hostile values fall back", () => {
  it.each([
    ["//evil.com", "%2F%2Fevil.com"],
    ["https://evil.com", "https%3A%2F%2Fevil.com"],
    ["/\\evil.com", "%2F%5Cevil.com"],
    ["%2F%2Fevil.com (double-encoded)", "%252F%252Fevil.com"],
    ["/login", "%2Flogin"],
  ])(
    "password login with redirect=%s pushes /dashboard",
    async (_label, encoded) => {
      setLoginUrl(`?redirect=${encoded}`);
      const auth = await mountAuth();
      await act(async () => {
        await auth().login("root", "secret");
      });
      expect(push).toHaveBeenCalledWith("/dashboard");
    },
  );

  it("password login without ?redirect= keeps the /dashboard default", async () => {
    setLoginUrl("");
    const auth = await mountAuth();
    await act(async () => {
      await auth().login("root", "secret");
    });
    expect(push).toHaveBeenCalledWith("/dashboard");
  });
});
