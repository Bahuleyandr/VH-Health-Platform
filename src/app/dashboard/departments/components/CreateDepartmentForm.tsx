// src/app/dashboard/departments/components/CreateDepartmentForm.tsx
'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { createDepartment } from '../actions';
import { useEffect, useRef } from 'react';

const initialState = { message: '', success: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="bg-blue-500 text-white p-2 rounded">
      {pending ? 'Creating...' : 'Create Department'}
    </button>
  );
}

export function CreateDepartmentForm() {
  const [state, formAction] = useFormState(createDepartment, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  // Reset the form after successful submission
  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
    }
  }, [state.success]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4 p-4 border rounded-lg bg-white shadow mb-6">
      <h3 className="text-lg font-semibold">Add New Department</h3>
      <div>
        <label htmlFor="name">Department Name</label>
        <input type="text" id="name" name="name" required className="border p-2 rounded w-full" />
      </div>
      <div>
        <label htmlFor="description">Description</label>
        <textarea id="description" name="description" className="border p-2 rounded w-full" />
      </div>
      <SubmitButton />
      {state?.message && (
         <p className={state.success ? 'text-green-600' : 'text-red-600'}>{state.message}</p>
      )}
    </form>
  );
}