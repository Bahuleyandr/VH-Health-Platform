// src/contexts/UserContext.tsx
"use client";

import { fetchAdminAPI } from "@/lib/api";
import { useRouter } from "next/navigation";
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

type User = {
  id: number | string;
  username?: string;
  email?: string;
  role?: string;
  is_active?: boolean;
  created_at?: string;
};

interface UserContextType {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const refreshUser = useCallback(async () => {
    try {
      const profile = await fetchAdminAPI<User>("/admin/auth/me", {
        method: "GET",
      });
      setUser(profile ?? null);
    } catch {
      // Not logged in or token invalid
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshUser();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshUser]);

  const login = useCallback(
    async (username: string, password: string): Promise<boolean> => {
      try {
        const res = await fetchAdminAPI<{ success?: boolean }>(
          "/admin/auth/login",
          { method: "POST", body: JSON.stringify({ username, password }) },
        );
        const ok = !!res?.success;
        if (ok) {
          await refreshUser();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [refreshUser],
  );

  const logout = useCallback(async () => {
    try {
      await fetchAdminAPI("/admin/auth/logout", { method: "POST" });
    } catch {
      // Logout API failure is non-fatal — we still clear local state
    } finally {
      setUser(null);
      router.push("/login");
    }
  }, [router]);

  return (
    <UserContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used within UserProvider");
  return ctx;
}
