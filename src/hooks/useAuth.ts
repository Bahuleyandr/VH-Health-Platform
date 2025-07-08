// src/hooks/useAuth.ts
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation'; // Changed from 'next/router'
import { getAuthToken } from '@/lib/api';

export const useAuth = (redirectTo: string = '/login') => {
  const router = useRouter();

  useEffect(() => {
    const token = getAuthToken();
    
    if (!token) {
      router.push(redirectTo);
    }
  }, [router, redirectTo]);

  return {
    isAuthenticated: !!getAuthToken(),
  };
};