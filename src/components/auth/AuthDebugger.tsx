// src/components/auth/AuthDebugger.tsx
'use client';

import { useAuth } from '@/contexts/AuthContext';
import { useState } from 'react';

export function AuthDebugger() {
  const { user, loading, error, checkAuth } = useAuth();
  const [showDebug, setShowDebug] = useState(false);

  if (process.env.NODE_ENV !== 'development') return null;

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <button
        onClick={() => setShowDebug(!showDebug)}
        className="bg-gray-800 text-white px-3 py-1 rounded text-sm"
      >
        🔧 Auth Debug
      </button>

      {showDebug && (
        <div className="absolute bottom-12 right-0 bg-white shadow-lg rounded-lg p-4 w-96 border">
          <h3 className="font-bold mb-2">Auth State</h3>
          
          <div className="space-y-2 text-sm">
            <div>
              <strong>Loading:</strong> {loading ? '🔄 Yes' : '✅ No'}
            </div>
            
            <div>
              <strong>Authenticated:</strong> {user ? '✅ Yes' : '❌ No'}
            </div>
            
            <div>
              <strong>Token:</strong> 
              {localStorage.getItem('adminToken') ? (
                <span className="text-green-600"> ✅ Present</span>
              ) : (
                <span className="text-red-600"> ❌ Missing</span>
              )}
            </div>
            
            {user && (
              <div className="mt-2 p-2 bg-gray-50 rounded">
                <strong>User Data:</strong>
                <pre className="text-xs mt-1 overflow-auto">
                  {JSON.stringify(user, null, 2)}
                </pre>
              </div>
            )}
            
            {error && (
              <div className="mt-2 p-2 bg-red-50 rounded">
                <strong>Error:</strong>
                <p className="text-red-600 text-xs mt-1">{error}</p>
              </div>
            )}
            
            <div className="mt-3 space-y-1">
              <button
                onClick={() => checkAuth()}
                className="w-full bg-blue-500 text-white px-3 py-1 rounded text-xs"
              >
                Refresh Auth State
              </button>
              
              <button
                onClick={() => {
                  console.log('Auth State:', { user, loading, error });
                  console.log('Local Storage:', {
                    token: localStorage.getItem('adminToken'),
                    user: localStorage.getItem('adminUser')
                  });
                }}
                className="w-full bg-gray-500 text-white px-3 py-1 rounded text-xs"
              >
                Log to Console
              </button>
              
              <button
                onClick={() => {
                  localStorage.clear();
                  window.location.reload();
                }}
                className="w-full bg-red-500 text-white px-3 py-1 rounded text-xs"
              >
                Clear All & Reload
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}