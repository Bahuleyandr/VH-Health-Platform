// src/contexts/AuthContext.tsx
'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { 
  adminLogin, 
  adminLogout, 
  getAdminProfile, 
  isAuthenticated, 
  getAdminUser,
  clearAuthData
} from '@/lib/api-client';

interface AdminUser {
  id: string;
  username: string;
  email?: string;
  role: string;
  permissions?: string[];
}

interface AuthContextType {
  user: AdminUser | null;
  loading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // Check authentication on mount
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      setLoading(true);
      setError(null);

      if (!isAuthenticated()) {
        setUser(null);
        return;
      }

      // Try to get stored user first
      const storedUser = getAdminUser();
      if (storedUser) {
        setUser(storedUser);
      }

      // Then fetch fresh profile data
      try {
        const profile = await getAdminProfile();
        if (profile) {
          setUser(profile);
          localStorage.setItem('adminUser', JSON.stringify(profile));
        }
      } catch (profileError) {
        console.error('Failed to fetch profile:', profileError);
        // If profile fetch fails but we have stored user, continue
        if (!storedUser) {
          throw profileError;
        }
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      setError((error as Error).message);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const login = async (username: string, password: string) => {
    try {
      setLoading(true);
      setError(null);

      const result = await adminLogin(username, password);
      
      if (result.success && result.admin) {
        setUser(result.admin);
        router.push('/dashboard');
      } else {
        throw new Error('Login successful but no admin data received');
      }
    } catch (error) {
      setError((error as Error).message || 'Login failed');
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      setLoading(true);
      await adminLogout();
      setUser(null);
      router.push('/login');
    } catch (error) {
      console.error('Logout error:', error);
      // Even if logout fails, clear local data
      setUser(null);
      router.push('/login');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, error, login, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}