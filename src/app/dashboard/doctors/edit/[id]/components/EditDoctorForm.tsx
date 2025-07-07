// src/app/dashboard/doctors/edit/[id]/components/EditDoctorForm.tsx
'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { updateDoctorAction } from '@/app/dashboard/doctors/actions';
import { Department, Doctor } from '@/lib/types';
import Link from 'next/link';

const initialState = { message: '', success: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="bg-blue-500 text-white p-2 rounded-md">
      {pending ? 'Saving Changes...' : 'Save Changes'}
    </button>
  );
}

export function EditDoctorForm({ doctor, departments }: { doctor: Doctor, departments: Department[] }) {
  const [state, formAction] = useFormState(updateDoctorAction, initialState);

  return (
    <form action={formAction} className="space-y-4 p-6 border rounded-lg bg-white shadow">
      <input type="hidden" name="user_id" value={doctor.user_id} />
      
      {/* Professional Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor="name">Full Name</label>
          <input type="text" id="name" name="name" required defaultValue={doctor.name} className="border p-2 rounded w-full" />
        </div>
        <div>
          <label htmlFor="department">Department</label>
          <select id="department" name="department" required defaultValue={doctor.department} className="border p-2 rounded w-full">
            {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="specialization">Specialization</label>
          <input type="text" id="specialization" name="specialization" required defaultValue={doctor.specialization} className="border p-2 rounded w-full" />
        </div>
         <div>
          <label htmlFor="consultation_fee">Consultation Fee (₹)</label>
          <input type="number" id="consultation_fee" name="consultation_fee" required defaultValue={doctor.consultation_fee} className="border p-2 rounded w-full" />
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