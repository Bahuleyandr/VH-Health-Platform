// src/hooks/useSessionTimeout.ts
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getToken, getTokenExp, isTokenExpired } from '@/lib/auth';
import { useAuth } from '@/contexts/AuthContext';

type UseSessionTimeoutOptions = {
  /** How often to check the token (ms). Default: 5000 */
  checkIntervalMs?: number;
  /** How many seconds of skew to allow before considering expired. Default: 30 */
  skewSeconds?: number;
  /** Optional redirect after logout */
  redirectPath?: string;
};

export function useSessionTimeout(options: UseSessionTimeoutOptions = {}) {
  const { logout } = useAuth();
  const checkIntervalMs = options.checkIntervalMs ?? 5000;
  const skewSeconds = options.skewSeconds ?? 30;
  const redirectPath = options.redirectPath ?? '/login';

  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const ticking = useRef<number | null>(null);

  const token = useMemo(() => (typeof window !== 'undefined' ? getToken() : null), []);
  const exp = useMemo(() => {
    if (!token) return null;
    return getTokenExp(token);
  }, [token]);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } finally {
      if (typeof window !== 'undefined' && redirectPath) {
        window.location.href = redirectPath;
      }
    }
  }, [logout, redirectPath]);

  useEffect(() => {
    // If no token or already expired, log out immediately
    if (!token || isTokenExpired(token, skewSeconds)) {
      void handleLogout();
      return;
    }

    // Initial seconds-left computation
    if (exp) {
      const now = Math.floor(Date.now() / 1000);
      setSecondsLeft(Math.max(0, exp - now));
    }

    // Start an interval to update seconds-left and auto-logout at expiry
    ticking.current = window.setInterval(() => {
      if (!token) return;

      if (isTokenExpired(token, skewSeconds)) {
        clearInterval(ticking.current as number);
        ticking.current = null;
        void handleLogout();
        return;
      }

      if (exp) {
        const now = Math.floor(Date.now() / 1000);
        setSecondsLeft(Math.max(0, exp - now));
      }
    }, checkIntervalMs);

    return () => {
      if (ticking.current) {
        clearInterval(ticking.current);
        ticking.current = null;
      }
    };
  }, [token, exp, skewSeconds, checkIntervalMs, handleLogout]);

  return {
    /** seconds until token expiry, or null if unknown */
    secondsLeft,
    /** convenience booleans */
    isExpiringSoon: secondsLeft !== null && secondsLeft <= 60, // last minute
    isExpired: secondsLeft !== null && secondsLeft <= 0,
    /** trigger a manual logout */
    logout: handleLogout,
  };
}
