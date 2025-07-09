// src/contexts/UserContext.tsx
'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthToken } from '@/lib/api';
import toast from 'react-hot-toast';

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  permissions: string[];
}

interface UserContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  // Fetch user data on mount and when auth state changes
  useEffect(() => {
    const fetchUser = async () => {
      const token = getAuthToken();
      
      if (!token) {
        setUser(null);
        setIsLoading(false);
        return;
      }

      try {
        // TODO: Replace with actual API endpoint
        const response = await fetch('/api/v1/admin/me', {
          credentials: 'include',
        });

        if (response.ok) {
          const userData = await response.json();
          setUser(userData);
        } else {
          setUser(null);
          if (response.status === 401) {
            router.push('/login');
          }
        }
      } catch (error) {
        console.error('Failed to fetch user:', error);
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    };

    fetchUser();
  }, [router]);

  const login = async (email: string, password: string) => {
    try {
      // This would use your login API
      const response = await fetch('/api/v1/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include',
      });

      if (response.ok) {
        const userData = await response.json();
        setUser(userData.user);
        toast.success('Login successful');
        router.push('/dashboard');
      } else {
        throw new Error('Login failed');
      }
    } catch (error) {
      toast.error('Login failed');
      throw error;
    }
  };

  const logout = async () => {
    try {
      await fetch('/api/v1/admin/logout', {
        method: 'POST',
        credentials: 'include',
      });
      setUser(null);
      router.push('/login');
      toast.success('Logged out successfully');
    } catch (error) {
      toast.error('Logout failed');
      throw error;
    }
  };

  const refreshUser = async () => {
    setIsLoading(true);
    // Re-fetch user data
    const token = getAuthToken();
    if (token) {
      try {
        const response = await fetch('/api/v1/admin/me', {
          credentials: 'include',
        });
        if (response.ok) {
          const userData = await response.json();
          setUser(userData);
        }
      } catch (error) {
        console.error('Failed to refresh user:', error);
      }
    }
    setIsLoading(false);
  };

  return (
    <UserContext.Provider value={{ user, isLoading, login, logout, refreshUser }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}

// Updated useCurrentUser hook for backwards compatibility
export function useCurrentUser() {
  const { user } = useUser();
  return user;
}