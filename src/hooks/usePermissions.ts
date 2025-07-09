// src/hooks/usePermissions.ts
import { useAuth } from './useAuth';

interface User {
  id: string;
  permissions?: string[];
}

// Create the missing useCurrentUser hook
export function useCurrentUser(): User | null {
  // This would typically come from a context or API call
  // For now, let's create a basic implementation
  const { isAuthenticated } = useAuth();
  
  // TODO: Replace with actual user data from API or context
  if (!isAuthenticated) return null;
  
  return {
    id: '1',
    permissions: ['read:users', 'write:users', 'delete:users'] // Example permissions
  };
}

export function usePermissions() {
  const user = useCurrentUser();
  
  const can = (action: string, resource: string) => {
    return user?.permissions?.includes(`${action}:${resource}`) || false;
  };
  
  return { can };
}