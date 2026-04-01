// src/hooks/useSessionTimeout.ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";

type UseSessionTimeoutOptions = {
  /** How often to ping /api/auth/verify (ms). Default: 60000 */
  checkIntervalMs?: number;
  /** Optional redirect after logout */
  redirectPath?: string;
};

export function useSessionTimeout(options: UseSessionTimeoutOptions = {}) {
  const { logout } = useAuth();
  const checkIntervalMs = options.checkIntervalMs ?? 60_000;
  const redirectPath = options.redirectPath ?? "/login";

  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const ticking = useRef<number | null>(null);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } finally {
      if (typeof window !== "undefined" && redirectPath) {
        window.location.href = redirectPath;
      }
    }
  }, [logout, redirectPath]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Auth token is in an httpOnly cookie — not accessible to JS.
    // Poll /api/auth/verify to check session validity server-side.
    const check = async () => {
      try {
        const res = await fetch("/api/auth/verify", { credentials: "include" });
        if (!res.ok) {
          void handleLogout();
          return;
        }
        const data = await res.json() as { expiresIn?: number };
        if (typeof data.expiresIn === "number") {
          setSecondsLeft(data.expiresIn);
        }
      } catch {
        // Network error — don't log out aggressively
      }
    };

    void check();
    ticking.current = window.setInterval(check, checkIntervalMs);

    return () => {
      if (ticking.current) {
        clearInterval(ticking.current);
        ticking.current = null;
      }
    };
  }, [checkIntervalMs, handleLogout]);

  return {
    secondsLeft,
    isExpiringSoon: secondsLeft !== null && secondsLeft <= 60,
    isExpired: secondsLeft !== null && secondsLeft <= 0,
    logout: handleLogout,
  };
}
