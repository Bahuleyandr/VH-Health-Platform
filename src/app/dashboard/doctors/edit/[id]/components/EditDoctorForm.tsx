// src/app/dashboard/doctors/edit/[id]/components/EditDoctorForm.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchAdminAPI } from '@/lib/api';
import { Department, Doctor } from '@/lib/types';
import Link from 'next/link';

interface EditDoctorFormProps {
  doctor: Doctor;
  departments: Department[];
}

export function EditDoctorForm({ doctor, departments }: EditDoctorFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const formData = new FormData(e.currentTarget);
    const data = {
      name: formData.get('name') as string,
      department: formData.get('department') as string,
      specialization: formData.get('specialization') as string,
      consultation_fee: parseInt(formData.get('consultation_fee') as string),
      is_available: formData.get('is_available') === 'on',
    };

    try {
      await fetchAdminAPI(`/doctors/${doctor.user_id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });

      // Redirect to the doctors list on success
      router.push('/dashboard/doctors');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
      setError(errorMessage);
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Professional Information</h2>
        
        {/* Professional Details */}
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
              defaultValue={doctor.name} 
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" 
              disabled={loading}
            />
          </div>
          
          <div>
            <label htmlFor="department" className="block text-sm font-medium text-gray-700 mb-1">
              Department *
            </label>
            <select 
              id="department" 
              name="department" 
              required 
              defaultValue={doctor.department} 
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" 
              disabled={loading}
            >
              {departments.map(d => (
                <option key={d.id} value={d.name}>{d.name}</option>
              ))}
            </select>
          </div>
          
          <div>
            <label htmlFor="specialization" className="block text-sm font-medium text-gray-700 mb-1">
              Specialization *
            </label>
            <input 
              type="text" 
              id="specialization" 
              name="specialization" 
              required 
              defaultValue={doctor.specialization} 
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" 
              disabled={loading}
            />
          </div>
          
          <div>
            <label htmlFor="consultation_fee" className="block text-sm font-medium text-gray-700 mb-1">
              Consultation Fee (₹) *
            </label>
            <input 
              type="number" 
              id="consultation_fee" 
              name="consultation_fee" 
              required 
              defaultValue={doctor.consultation_fee} 
              min="0"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" 
              disabled={loading}
            />
          </div>
        </div>

        {/* Availability Toggle */}
        <div className="mt-6 pt-6 border-t">
          <label className="flex items-center cursor-pointer">
            <input
              type="checkbox"
              name="is_available"
              defaultChecked={doctor.is_available}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              disabled={loading}
            />
            <span className="ml-2 text-sm font-medium text-gray-700">
              Available for appointments
            </span>
          </label>
        </div>
      </div>

      {/* Contact Information (Read-only) */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Contact Information (Read-only)</h2>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email Address
            </label>
            <input 
              type="email" 
              value={doctor.email} 
              readOnly
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-gray-500" 
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Phone Number
            </label>
            <input 
              type="tel" 
              value={doctor.phone} 
              readOnly
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-gray-500" 
            />
          </div>
        </div>
      </div>
      
      {/* Form Actions */}
      <div className="flex items-center gap-4">
        <button 
          type="submit" 
          disabled={loading} 
          className={`px-4 py-2 rounded-md font-medium ${
            loading 
              ? 'bg-gray-400 text-gray-200 cursor-not-allowed' 
              : 'bg-blue-600 text-white hover:bg-blue-700'
          } transition-colors`}
        >
          {loading ? 'Saving Changes...' : 'Save Changes'}
        </button>
        <Link 
          href="/dashboard/doctors" 
          className={`text-gray-500 hover:text-gray-700 ${loading ? 'pointer-events-none' : ''}`}
        >
          Cancel
        </Link>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}
    </form>
  );
}