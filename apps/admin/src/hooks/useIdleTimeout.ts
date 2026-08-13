// src/hooks/useIdleTimeout.ts
"use client";

import { useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { toast } from "react-hot-toast";
import {
  adminLogout,
  clearAuthData,
  IDLE_SIGN_OUT_WARNING_KEY,
} from "@/lib/api-client";

const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const EVENTS = ["mousedown", "mousemove", "keydown", "scroll", "touchstart"] as const;

const SERVER_REVOCATION_WARNING =
  "Your local session was cleared after inactivity, but server-side session revocation failed. Your previous session may still be active; contact an administrator.";

/**
 * Hook that monitors user activity and auto-logs out after
 * IDLE_TIMEOUT_MS of inactivity.
 *
 * Usage: call `useIdleTimeout()` in your protected layout.
 */
export function useIdleTimeout(timeoutMs = IDLE_TIMEOUT_MS) {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const logout = useCallback(async () => {
    try {
      const result = await adminLogout();
      if (!result.serverSignOutOk) {
        try {
          sessionStorage.setItem(IDLE_SIGN_OUT_WARNING_KEY, SERVER_REVOCATION_WARNING);
        } catch {
          /* storage may be unavailable; the toast remains visible */
        }
        Sentry.captureMessage("Idle sign-out backend revocation failed", {
          level: "error",
          extra: { serverSignOutError: result.serverSignOutError },
        });
        toast.error(SERVER_REVOCATION_WARNING, { duration: 10000 });
      }
    } catch (error) {
      try {
        sessionStorage.setItem(IDLE_SIGN_OUT_WARNING_KEY, SERVER_REVOCATION_WARNING);
      } catch {
        /* storage may be unavailable; the toast remains visible */
      }
      Sentry.captureException(error, {
        tags: { operation: "idle-sign-out" },
      });
      toast.error(SERVER_REVOCATION_WARNING, { duration: 10000 });
    } finally {
      clearAuthData();
      router.push("/login?reason=idle");
    }
  }, [router]);

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(logout, timeoutMs);
  }, [logout, timeoutMs]);

  useEffect(() => {
    // Start the timer
    resetTimer();

    // Reset on user activity
    const handler = () => resetTimer();
    for (const event of EVENTS) {
      window.addEventListener(event, handler, { passive: true });
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const event of EVENTS) {
        window.removeEventListener(event, handler);
      }
    };
  }, [resetTimer]);
}
