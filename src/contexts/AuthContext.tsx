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
import {
  adminLogin,
  staffLogin,
  adminLogout,
  getAdminProfile,
  isAuthenticated,
  getAdminUser,
  clearAuthData,
} from "@/lib/api-client";
import type { AdminUser } from "@/lib/types";

interface AuthContextType {
  user: AdminUser | null;
  loading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
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
        // Clear stale cookie if localStorage has no token
        document.cookie = 'adminToken=; path=/; max-age=0';
        setUser(null);
        return;
      }

      // Sync cookie with localStorage token (for middleware SSR access)
      const existingToken = typeof window !== "undefined" ? localStorage.getItem("adminToken") : null;
      if (existingToken) {
        document.cookie = `adminToken=${existingToken}; path=/; max-age=${8 * 60 * 60}; SameSite=Strict; Secure`;
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

  const setTokenCookie = (token: string) => {
    document.cookie = `adminToken=${token}; path=/; max-age=${8 * 60 * 60}; SameSite=Strict; Secure`;
  };

  const login = useCallback(
    async (username: string, password: string) => {
      try {
        setLoading(true);
        setError(null);

        const result = await adminLogin(username, password);
        // api-client persists token/admin to localStorage; we update state & route
        if (result?.admin) {
          setUser(result.admin);
          setTokenCookie(result.token);
          router.push("/dashboard");
        } else {
          throw new Error("Login successful but no admin data received");
        }
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

  const loginStaff = useCallback(
    async (employeeId: string, password: string) => {
      try {
        setLoading(true);
        setError(null);

        const result = await staffLogin(employeeId, password);
        if (result.user) {
          setUser(result.user);
        }
        setTokenCookie(result.token);
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
      await adminLogout(); // clears local storage inside
    } catch (e) {
      console.warn("Logout error:", e);
      clearAuthData();
    } finally {
      // Clear cookie for middleware
      document.cookie = 'adminToken=; path=/; max-age=0';
      setUser(null);
      setLoading(false);
      router.push("/login");
    }
  }, [router]);

  return (
    <AuthContext.Provider
      value={{ user, loading, error, login, loginStaff, logout, checkAuth }}
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
