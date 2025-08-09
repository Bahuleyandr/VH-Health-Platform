// src/contexts/UserContext.tsx
'use client';

import React, { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { fetchAdminAPI } from '@/lib/api';

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

function getErrorMessage(e: unknown) {
  if (e instanceof Error) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    (async () => {
      await refreshUser();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshUser = async () => {
    try {
      // Prefer your actual "who am I" endpoint; update path if different:
      const profile = await fetchAdminAPI<User>('/admin/auth/me', { method: 'GET' });
      if (profile) setUser(profile);
    } catch (e: unknown) {
      // Not logged in or token invalid; ignore
      // console.debug('refreshUser:', getErrorMessage(e));
      setUser(null);
    }
  };

  const login = async (username: string, password: string): Promise<boolean> => {
  try {
    const res = await fetchAdminAPI<{ success?: boolean }>(
      '/admin/auth/login',
      {
        method: 'POST',
        // send JSON as a string; no `headers` field here
        body: JSON.stringify({ username, password }),
      }
    );

    const ok = !!res?.success;
    if (ok) {
      await refreshUser();
      return true;
    }
    return false;
  } catch (e: unknown) {
    console.error('Login error:', getErrorMessage(e));
    return false;
  }
};

  const logout = async () => {
    try {
      // Update path if your API expects POST/DELETE/etc.
      await fetchAdminAPI('/admin/auth/logout', { method: 'POST' });
    } catch (e: unknown) {
      console.error('Logout error:', getErrorMessage(e));
    } finally {
      setUser(null);
      router.push('/login');
    }
  };

  return (
    <UserContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser must be used within UserProvider');
  return ctx;
}
