// src/hooks/useIdleTimeout.ts
"use client";

import { useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { clearAuthData } from "@/lib/api-client";

const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const EVENTS = ["mousedown", "mousemove", "keydown", "scroll", "touchstart"] as const;

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
      await fetch("/api/logout", { method: "POST" }).catch(() => {});
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
