// src/app/dashboard/departments/edit/[id]/components/EditDepartmentForm.tsx
'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { updateDepartment } from '@/app/dashboard/departments/actions';
import { Department } from '@/lib/types';
import Link from 'next/link';

const initialState = { message: '', success: false };

function SubmitButton() {
    const { pending } = useFormStatus();
    return (
        <button type="submit" disabled={pending} className="bg-blue-500 text-white p-2 rounded">
        {pending ? 'Updating...' : 'Save Changes'}
        </button>
    );
}

export function EditDepartmentForm({ department }: { department: Department }) {
  const [state, formAction] = useFormState(updateDepartment, initialState);

  return (
    <form action={formAction} className="space-y-4 p-4 border rounded-lg bg-white shadow">
      {/* Hidden input to pass the department ID to the action */}
      <input type="hidden" name="id" value={department.id} />

      <div>
        <label htmlFor="name">Department Name</label>
        <input 
          type="text" 
          id="name" 
          name="name" 
          required 
          className="border p-2 rounded w-full"
          defaultValue={department.name} 
        />
      </div>
      <div>
        <label htmlFor="description">Description</label>
        <textarea 
          id="description" 
          name="description" 
          className="border p-2 rounded w-full"
          defaultValue={department.description}
        />
      </div>

      <div className="flex items-center gap-4">
        <SubmitButton />
        <Link href="/dashboard/departments" className="text-gray-500">Cancel</Link>
      </div>

      {state?.message && (
         <p className={state.success ? 'text-green-600' : 'text-red-600'}>{state.message}</p>
      )}
    </form>
  );
}