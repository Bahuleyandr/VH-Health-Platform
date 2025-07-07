// src/app/dashboard/admin-management/components/CreateAdminForm.tsx
'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { createAdminAction } from '../actions';
import { useEffect, useRef } from 'react';

const initialState = { message: '', success: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="bg-blue-500 text-white p-2 rounded-md">
      {pending ? 'Creating...' : 'Create Admin'}
    </button>
  );
}

export function CreateAdminForm() {
  const [state, formAction] = useFormState(createAdminAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
    }
  }, [state.success]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4 p-4 border rounded-lg bg-white shadow mb-6">
      <h3 className="text-lg font-semibold">Add New Administrator</h3>
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
          <label htmlFor="password">Password</label>
          <input type="password" id="password" name="password" required className="border p-2 rounded w-full" />
        </div>
         <div>
          <label htmlFor="role">Role</label>
          <select id="role" name="role" required className="border p-2 rounded w-full">
            <option value="ADMIN">Admin</option>
            <option value="SUPER_ADMIN">Super Admin</option>
          </select>
        </div>
      </div>
      <SubmitButton />
      {state?.message && (
         <p className={`mt-2 text-sm ${state.success ? 'text-green-600' : 'text-red-600'}`}>{state.message}</p>
      )}
    </form>
  );
}