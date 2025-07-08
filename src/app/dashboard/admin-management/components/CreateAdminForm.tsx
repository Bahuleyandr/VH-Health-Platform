// src/app/dashboard/admin-management/components/CreateAdminForm.tsx
'use client';

import { useState, useEffect } from 'react';
import { fetchAdminAPI } from '@/lib/api';

interface CreateAdminFormProps {
  onAdminCreated?: () => void;
}

export function CreateAdminForm({ onAdminCreated }: CreateAdminFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Clear success message after 5 seconds
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => {
        setSuccess('');
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    const formData = new FormData(e.currentTarget);
    const data = {
      name: formData.get('name') as string,
      email: formData.get('email') as string,
      password: formData.get('password') as string,
      role: formData.get('role') as string,
    };

    // Validation
    if (!data.name || !data.email || !data.password) {
      setError('Name, Email, and Password are required.');
      setLoading(false);
      return;
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      setError('Please enter a valid email address.');
      setLoading(false);
      return;
    }

    // Password validation (minimum 8 characters)
    if (data.password.length < 8) {
      setError('Password must be at least 8 characters long.');
      setLoading(false);
      return;
    }

    try {
      await fetchAdminAPI('/auth/admin/create-admin', {
        method: 'POST',
        body: JSON.stringify(data),
      });

      setSuccess('Admin user created successfully!');
      
      // Reset form
      e.currentTarget.reset();
      
      // Notify parent to refresh the list
      if (onAdminCreated) {
        onAdminCreated();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-6 border rounded-lg bg-white shadow">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-900">Add New Administrator</h3>
        <span className="text-xs text-gray-500">* Required fields</span>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
            Full Name *
          </label>
          <input 
            type="text" 
            id="name" 
            name="name" 
            required 
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" 
            disabled={loading}
            placeholder="John Doe"
          />
        </div>
        
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
            Email Address *
          </label>
          <input 
            type="email" 
            id="email" 
            name="email" 
            required 
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" 
            disabled={loading}
            placeholder="admin@vhhealth.app"
          />
        </div>
        
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
            Password *
          </label>
          <input 
            type="password" 
            id="password" 
            name="password" 
            required 
            minLength={8}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" 
            disabled={loading}
            placeholder="Minimum 8 characters"
          />
          <p className="mt-1 text-xs text-gray-500">Must be at least 8 characters long</p>
        </div>
        
        <div>
          <label htmlFor="role" className="block text-sm font-medium text-gray-700 mb-1">
            Role *
          </label>
          <select 
            id="role" 
            name="role" 
            required 
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" 
            disabled={loading}
          >
            <option value="ADMIN">Admin</option>
            <option value="SUPER_ADMIN">Super Admin</option>
          </select>
        </div>
      </div>
      
      <div>
        <button 
          type="submit" 
          disabled={loading} 
          className={`px-4 py-2 rounded-md font-medium transition-colors ${
            loading 
              ? 'bg-gray-400 text-gray-200 cursor-not-allowed' 
              : 'bg-blue-600 text-white hover:bg-blue-700'
          }`}
        >
          {loading ? 'Creating...' : 'Create Admin'}
        </button>
      </div>

      {success && (
        <div className="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded">
          {success}
        </div>
      )}

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}
    </form>
  );
}