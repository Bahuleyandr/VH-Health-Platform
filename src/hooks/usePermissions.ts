// src/hooks/usePermissions.ts
export function usePermissions() {
  const user = useCurrentUser();
  
  const can = (action: string, resource: string) => {
    // Check user permissions
    return user?.permissions?.includes(`${action}:${resource}`);
  };
  
  return { can };
}

// Usage in components
const { can } = usePermissions();

{can('delete', 'users') && (
  <button onClick={handleDelete}>Delete User</button>
)}