// TEMPORARY FILE: src/app/login-dev/page.tsx
// ⚠️ WARNING: This is for development only! Remove before deploying!

'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function DevLoginPage() {
  const router = useRouter();

  useEffect(() => {
    // Set a dummy token for development
    localStorage.setItem('adminToken', 'dev-token-12345');
    
    // Redirect to dashboard
    router.push('/dashboard');
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h2 className="text-2xl font-bold mb-4">Development Login</h2>
        <p>Setting up development session...</p>
      </div>
    </div>
  );
}