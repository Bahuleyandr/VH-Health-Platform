// src/contexts/AuthContext.tsx
"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
  useCallback,
} from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import {
  adminLogin,
  staffLogin,
  adminLogout,
  getAdminProfile,
  isAuthenticated,
  getAdminUser,
  clearAuthData,
  verifyAdminMfa,
  adminMfaSetupEnroll,
  adminMfaSetupConfirm,
} from "@/lib/api-client";
import type { AdminUser } from "@/lib/types";

/** Describes the second-factor challenge returned by `login` when the admin
 *  account has MFA enabled. Callers must complete the flow via `verifyMfa`. */
export interface MfaChallenge {
  challengeToken: string;
  expiresAt?: string;
  adminHint?: { username?: string };
}

/** Describes the first-time MFA setup handshake returned by `login` when a
 *  SUPER_ADMIN without TOTP attempts to log in while
 *  REQUIRE_MFA_FOR_SUPER_ADMIN is on. Callers must complete enrollment via
 *  `mfaSetupEnroll` + `mfaSetupConfirm` before any dashboard access. */
export interface MfaSetupChallenge {
  setupToken: string;
  expiresIn: number;
  adminHint?: { username?: string };
}

/** Discriminated result returned by `login` so the UI can distinguish "go to
 *  dashboard" from "prompt for TOTP" from "enroll MFA first". */
export type LoginOutcome =
  | { kind: "success" }
  | { kind: "mfa"; challenge: MfaChallenge }
  | { kind: "mfa_setup_required"; challenge: MfaSetupChallenge };

interface AuthContextType {
  user: AdminUser | null;
  loading: boolean;
  error: string | null;
  /** Admin password login. Returns a discriminated union so the caller can
   *  render a TOTP prompt when the backend asks for a second factor. */
  login: (username: string, password: string) => Promise<LoginOutcome>;
  /** Completes the 2FA step after a `login()` that returned `{ kind: "mfa" }`. */
  verifyMfa: (args: { challengeToken: string; code: string; useBackupCode?: boolean }) => Promise<void>;
  /** First leg of first-time MFA enrollment — returns QR + backup codes + encryptedSecret. */
  mfaSetupEnroll: (args: { setupToken: string }) => Promise<{
    qrCodeDataUrl: string;
    otpauthUrl: string;
    backupCodes: string[];
    encryptedSecret: string;
  }>;
  /** Second leg of first-time MFA enrollment — confirms the code and logs the admin in. */
  mfaSetupConfirm: (args: {
    setupToken: string;
    code: string;
    encryptedSecret: string;
    backupCodes: string[];
  }) => Promise<void>;
  loginStaff: (employeeId: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const checkAuth = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      if (!isAuthenticated()) {
        setUser(null);
        return;
      }

      // Use cached user first for instant UI
      const cached = getAdminUser();
      if (cached) setUser(cached);

      // Then refresh from API (will redirect on 401 via api layer)
      try {
        const fresh = await getAdminProfile();
        if (fresh) {
          setUser(fresh);
          if (typeof window !== "undefined") {
            localStorage.setItem("adminUser", JSON.stringify(fresh));
          }
        }
      } catch {
        // If profile fails and no cached user, treat as unauthenticated
        if (!cached) {
          clearAuthData();
          setUser(null);
        }
        // keep going; api layer may already have redirected on 401
      }
    } catch (e) {
      console.error("Auth check failed:", e);
      setError((e as Error).message ?? "Auth check failed");
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // initial mount
    void checkAuth();
  }, [checkAuth]);

  const login = useCallback(
    async (username: string, password: string): Promise<LoginOutcome> => {
      try {
        setLoading(true);
        setError(null);

        const result = await adminLogin(username, password);

        // Backend requested a second factor — surface the challenge to the UI.
        if (result.requiresTwoFactor) {
          return {
            kind: "mfa",
            challenge: {
              challengeToken: result.challengeToken,
              expiresAt: result.expiresAt,
              adminHint: result.admin?.username ? { username: result.admin.username } : undefined,
            },
          };
        }

        // Backend requires first-time MFA enrollment — surface the setup handshake.
        if (result.requiresMfaSetup) {
          return {
            kind: "mfa_setup_required",
            challenge: {
              setupToken: result.setupToken,
              expiresIn: result.expiresIn,
              adminHint: result.admin?.username ? { username: result.admin.username } : undefined,
            },
          };
        }

        if (result?.admin) {
          setUser(result.admin);
          router.push("/dashboard");
          return { kind: "success" };
        }
        throw new Error("Login successful but no admin data received");
      } catch (e) {
        const msg = (e as Error).message || "Login failed";
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [router],
  );

  const verifyMfa = useCallback(
    async (args: { challengeToken: string; code: string; useBackupCode?: boolean }) => {
      try {
        setLoading(true);
        setError(null);
        const result = await verifyAdminMfa(args);
        if (result?.admin) setUser(result.admin);
        router.push("/dashboard");
      } catch (e) {
        const msg = (e as Error).message || "MFA verification failed";
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [router],
  );

  const mfaSetupEnroll = useCallback(
    async (args: { setupToken: string }) => {
      setError(null);
      return adminMfaSetupEnroll(args);
    },
    [],
  );

  const mfaSetupConfirm = useCallback(
    async (args: {
      setupToken: string;
      code: string;
      encryptedSecret: string;
      backupCodes: string[];
    }) => {
      try {
        setLoading(true);
        setError(null);
        const result = await adminMfaSetupConfirm(args);
        if (result?.admin) setUser(result.admin);
        router.push("/dashboard");
      } catch (e) {
        const msg = (e as Error).message || "MFA setup failed";
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [router],
  );

  const loginStaff = useCallback(
    async (employeeId: string, password: string) => {
      try {
        setLoading(true);
        setError(null);

        const result = await staffLogin(employeeId, password);
        if (result.user) {
          setUser(result.user);
        }
        router.push("/dashboard");
      } catch (e) {
        const msg = (e as Error).message || "Staff login failed";
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [router],
  );

  const logout = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      // Clears local storage + cookie inside, and reports whether the BACKEND
      // acknowledged the server-side sign-out. A backend failure means the
      // server-side session token may still be alive (the backend fails logout
      // closed when its revocation store is down) — say so honestly instead of
      // pretending the sign-out completed.
      const result = await adminLogout();
      if (!result.serverSignOutOk) {
        toast.error(
          "Signed out on this device, but the server-side sign-out failed. " +
            "Your session may still be active on the server — please retry " +
            "signing in and out, or contact an administrator.",
          { duration: 10000 },
        );
      }
    } catch (e) {
      // Unexpected client-side failure (adminLogout itself no longer throws
      // for backend errors). Still ensure local state is gone, and be honest
      // that the server side was not confirmed.
      console.warn("Logout error:", e);
      clearAuthData();
      toast.error(
        "Signed out on this device, but the server-side sign-out could not be confirmed.",
        { duration: 10000 },
      );
    } finally {
      // The httpOnly auth_token cookie is cleared server-side by the backend logout endpoint.
      // No client-side document.cookie manipulation needed or safe here.
      setUser(null);
      setLoading(false);
      router.push("/login");
    }
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        login,
        verifyMfa,
        mfaSetupEnroll,
        mfaSetupConfirm,
        loginStaff,
        logout,
        checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
