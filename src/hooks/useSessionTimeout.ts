// src/hooks/useSessionTimeout.ts
export function useSessionTimeout() {
  const [showWarning, setShowWarning] = useState(false);
  const router = useRouter();
  
  useEffect(() => {
    let warningTimer: NodeJS.Timeout;
    let logoutTimer: NodeJS.Timeout;
    
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