// src/app/dashboard/doctors/components/CreateDoctorForm.tsx
'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { createDoctorAction } from '../actions';
import { Department } from '@/lib/types';
import Link from 'next/link';

const initialState = { message: '', success: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="bg-blue-500 text-white p-2 rounded-md">
      {pending ? 'Creating Doctor...' : 'Create Doctor'}
    </button>
  );
}

export function CreateDoctorForm({ departments }: { departments: Department[] }) {
  const [state, formAction] = useFormState(createDoctorAction, initialState);

  return (
    <form action={formAction} className="space-y-4 p-6 border rounded-lg bg-white shadow">
      {/* Personal Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor="name">Full Name</label>
          <input type="text" id="name" name="name" required className="border p-2 rounded w-full" />
        </div>
        <div>
          <label htmlFor="email">Email Address</label>
          <input type="email" id="email" name="email" required className="border p-2 rounded w-full" />
        </div>
        <div>
          <label htmlFor="phone">Phone Number</label>
          <input type="tel" id="phone" name="phone" required className="border p-2 rounded w-full" />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input type="password" id="password" name="password" required className="border p-2 rounded w-full" />
        </div>
      </div>

      {/* Professional Details */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label htmlFor="department">Department</label>
          <select id="department" name="department" required className="border p-2 rounded w-full">
            <option value="">Select Department</option>
            {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="specialization">Specialization</label>
          <input type="text" id="specialization" name="specialization" required className="border p-2 rounded w-full" />
        </div>
        <div>
          <label htmlFor="consultation_fee">Consultation Fee (₹)</label>
          <input type="number" id="consultation_fee" name="consultation_fee" required className="border p-2 rounded w-full" />
        </div>
      </div>
      
      <div className="flex items-center gap-4 pt-4">
        <SubmitButton />
        <Link href="/dashboard/doctors" className="text-gray-500">Cancel</Link>
      </div>

      {state?.message && !state.success && (
         <p className="text-red-600">{state.message}</p>
      )}
    </form>
  );
}