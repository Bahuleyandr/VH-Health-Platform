// src/app/login/page.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoginFormSchema } from '@/lib/schemas';
import { adminLogin } from '@/lib/api-client';
import * as Sentry from "@sentry/nextjs";
import type { z } from 'zod';

type LoginFormData = z.infer<typeof LoginFormSchema>;

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormData>({
    resolver: zodResolver(LoginFormSchema),
  });

  const onSubmit = async (data: LoginFormData) => {
    try {
      setError('');
      console.log('Attempting login with:', data.username); // Debug log
      
      // First, login to the backend
      const response = await adminLogin(data.username, data.password);
      console.log('Backend login response:', response); // Debug log
      
      if (!response.token) {
        throw new Error('No token received from backend');
      }

      // Then set the cookie via our API route
      const cookieResponse = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: response.token }),
      });

      console.log('Cookie response status:', cookieResponse.status); // Debug log

      if (!cookieResponse.ok) {
        const errorText = await cookieResponse.text();
        console.error('Cookie setting failed:', errorText);
        throw new Error('Failed to set authentication cookie');
      }

      // If everything is successful, redirect to dashboard
      router.push('/dashboard');
      
    } catch (err) {
      console.error('Login error:', err); // Debug log
      Sentry.captureException(err);
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="w-full max-w-md p-8 space-y-6 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg shadow-md">
        <h2 className="text-2xl font-bold text-center text-gray-900 dark:text-white">
          VH Health Admin Login
        </h2>
        
        <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <div>
            <label htmlFor="username" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Username
            </label>
            <input
              {...register('username')}
              type="text"
              autoComplete="username"
              className="mt-1 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              placeholder="Enter your username"
            />
            {errors.username && (
              <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.username.message}</p>
            )}
          </div>
          
          <div>
            <label htmlFor="password" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Password
            </label>
            <input
              {...register('password')}
              type="password"
              autoComplete="current-password"
              className="mt-1 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              placeholder="Password"
            />
            {errors.password && (
              <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.password.message}</p>
            )}
          </div>
          
          {error && (
            <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-900/20 p-3 rounded">
              {error}
            </div>
          )}
          
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-2 px-4 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Signing in...' : 'Sign in'}
          </button>
          
          <div className="text-sm text-gray-600 dark:text-gray-400 text-center">
            <p>Default credentials:</p>
            <p>Username: <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">admin</code></p>
            <p>Password: <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">Admin123!</code></p>
          </div>
        </form>
      </div>
    </div>
  );
}