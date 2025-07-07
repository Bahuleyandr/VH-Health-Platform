// src/app/dashboard/notifications/components/SendAnnouncementForm.tsx
'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { sendAnnouncementAction } from '../actions';
import { useEffect, useRef } from 'react';

const initialState = { message: '', success: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="bg-blue-500 text-white p-2 rounded">
      {pending ? 'Sending...' : 'Send Announcement'}
    </button>
  );
}

export function SendAnnouncementForm() {
  const [state, formAction] = useFormState(sendAnnouncementAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
    }
  }, [state.success]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4 p-4 border rounded-lg bg-white shadow mb-6">
      <h3 className="text-lg font-semibold">Send System-Wide Announcement</h3>
      <div>
        <label htmlFor="title">Title</label>
        <input type="text" id="title" name="title" required className="border p-2 rounded w-full" />
      </div>
      <div>
        <label htmlFor="body">Message</label>
        <textarea id="body" name="body" required rows={4} className="border p-2 rounded w-full" />
      </div>
      <SubmitButton />
      {state?.message && (
         <p className={state.success ? 'text-green-600' : 'text-red-600'}>{state.message}</p>
      )}
    </form>
  );
}