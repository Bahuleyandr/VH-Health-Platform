// src/app/dashboard/notifications/actions.ts
'use server';

import { sendAnnouncement } from '@/lib/api';
import { revalidatePath } from 'next/cache';

interface FormState {
  message: string;
  success: boolean;
}

export async function sendAnnouncementAction(
  prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const title = formData.get('title') as string;
  const body = formData.get('body') as string;

  if (!title || !body) {
    return { message: 'Title and Body are required.', success: false };
  }

  try {
    // This function calls the POST /announcement endpoint
    await sendAnnouncement({ title, body });

    // Refresh the data on the notifications page
    revalidatePath('/dashboard/notifications');
    
    return { message: 'Announcement sent successfully.', success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
    return { message: errorMessage, success: false };
  }
}