// src/components/auth/AuthDebugger.tsx
'use client';

import { useAuth } from '@/contexts/AuthContext';
import { useEffect, useState, useCallback } from 'react';

const IS_DEV = process.env.NODE_ENV === 'development';

export function AuthDebugger() {
  // In production, render nothing and don't mount the hook-using component
  if (!IS_DEV) return null;
  return <DevAuthDebugger />;
}

function DevAuthDebugger() {
  const { user, loading, error, checkAuth } = useAuth();
  const [showDebug, setShowDebug] = useState(false);

  // Avoid touching localStorage during render to prevent hydration mismatch
  const [tokenPresent, setTokenPresent] = useState<boolean | null>(null);
  const [cachedUserPreview, setCachedUserPreview] = useState<string | null>(null);

  const refreshLocalCache = useCallback(() => {
    try {
      const token = localStorage.getItem('adminToken');
      const u = localStorage.getItem('adminUser');
      setTokenPresent(!!token);
      setCachedUserPreview(
        u
          ? (() => {
              try {
                const parsed = JSON.parse(u);
                return JSON.stringify(
                  { id: parsed?.id, email: parsed?.email, role: parsed?.role },
                  null,
                  2
                );
              } catch {
                return '(invalid JSON in localStorage: adminUser)';
              }
            })()
          : null
      );
    } catch {
      setTokenPresent(false);
      setCachedUserPreview(null);
    }
  }, []);

  useEffect(() => {
    // run once on mount
    refreshLocalCache();
  }, [refreshLocalCache]);

  useEffect(() => {
    // update preview when auth state changes
    refreshLocalCache();
  }, [user, loading, error, refreshLocalCache]);

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <button
        type="button"
        onClick={() => setShowDebug((s) => !s)}
        className="bg-gray-800 text-white px-3 py-1 rounded text-sm"
        aria-expanded={showDebug}
      >
        🔧 Auth Debug
      </button>

      {showDebug && (
        <div className="absolute bottom-12 right-0 w-96 rounded-lg border bg-white p-4 shadow-lg">
          <h3 className="mb-2 font-bold">Auth State</h3>

          <div className="space-y-2 text-sm">
            <div>
              <strong>Loading:</strong> {loading ? '🔄 Yes' : '✅ No'}
            </div>

            <div>
              <strong>Authenticated:</strong> {user ? '✅ Yes' : '❌ No'}
            </div>

            <div>
              <strong>Token:</strong>{' '}
              {tokenPresent === null ? '…' : tokenPresent ? (
                <span className="text-green-600">✅ Present</span>
              ) : (
                <span className="text-red-600">❌ Missing</span>
              )}
            </div>

            {user && (
              <div className="mt-2 rounded bg-gray-50 p-2">
                <strong>User (context):</strong>
                <pre className="mt-1 overflow-auto text-xs">
                  {JSON.stringify(user, null, 2)}
                </pre>
              </div>
            )}

            {cachedUserPreview && (
              <div className="mt-2 rounded bg-gray-50 p-2">
                <strong>User (localStorage preview):</strong>
                <pre className="mt-1 overflow-auto text-xs">{cachedUserPreview}</pre>
              </div>
            )}

            {error && (
              <div className="mt-2 rounded bg-red-50 p-2">
                <strong>Error:</strong>
                <p className="mt-1 text-xs text-red-600">{error}</p>
              </div>
            )}

            <div className="mt-3 space-y-1">
              <button
                type="button"
                onClick={() => checkAuth()}
                className="w-full rounded bg-blue-500 px-3 py-1 text-white text-xs"
              >
                Refresh Auth State
              </button>

              <button
                type="button"
                onClick={() => {
                  try {
                    console.log('Auth State (context):', { user, loading, error });
                    console.log('Local Storage:', {
                      token: localStorage.getItem('adminToken'),
                      user: localStorage.getItem('adminUser'),
                    });
                    refreshLocalCache();
                  } catch (e) {
                    console.warn('Unable to inspect localStorage:', e);
                  }
                }}
                className="w-full rounded bg-gray-500 px-3 py-1 text-white text-xs"
              >
                Log to Console
              </button>

              <button
                type="button"
                onClick={() => {
                  try {
                    localStorage.clear();
                  } catch {}
                  window.location.reload();
                }}
                className="w-full rounded bg-red-500 px-3 py-1 text-white text-xs"
              >
                Clear All &amp; Reload
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
