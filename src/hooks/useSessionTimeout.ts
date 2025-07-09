// src/hooks/useSessionTimeout.ts
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { logout } from '@/lib/api';
import toast from 'react-hot-toast';

export function useSessionTimeout() {
  const [showWarning, setShowWarning] = useState(false);
  const router = useRouter();
  
  const handleLogout = async () => {
    try {
      await logout();
      router.push('/login');
    } catch (error) {
      toast.error('Failed to logout');
    }
  };
  
  useEffect(() => {
    let warningTimer: ReturnType<typeof setTimeout>;
    let logoutTimer: ReturnType<typeof setTimeout>;
    
    const resetTimers = () => {
      clearTimeout(warningTimer);
      clearTimeout(logoutTimer);
      
      // Show warning after 25 minutes
      warningTimer = setTimeout(() => {
        setShowWarning(true);
      }, 25 * 60 * 1000);
      
      // Auto logout after 30 minutes
      logoutTimer = setTimeout(() => {
        handleLogout();
      }, 30 * 60 * 1000);
    };
    
    // Reset on user activity
    const handleActivity = () => {
      setShowWarning(false);
      resetTimers();
    };
    
    window.addEventListener('click', handleActivity);
    window.addEventListener('keypress', handleActivity);
    
    resetTimers();
    
    return () => {
      clearTimeout(warningTimer);
      clearTimeout(logoutTimer);
      window.removeEventListener('click', handleActivity);
      window.removeEventListener('keypress', handleActivity);
    };
  }, []);
  
  return { showWarning, extendSession: () => setShowWarning(false) };
}