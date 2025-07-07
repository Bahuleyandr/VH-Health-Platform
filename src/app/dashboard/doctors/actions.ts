// src/app/dashboard/doctors/actions.ts
'use server';

import { createDoctor } from '@/lib/api';
import { updateDoctorProfile } from '@/lib/api';
import { deleteDoctor } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

interface FormState {
  message: string;
  success: boolean;
  errors?: Record<string, string>; // For field-specific errors
}

export async function createDoctorAction(
  prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const data = Object.fromEntries(formData.entries());

  // Basic validation
  if (!data.name || !data.email || !data.password || !data.phone || !data.department || !data.specialization) {
    return { message: 'Please fill out all required fields.', success: false };
  }

  try {
    // This function calls the POST /doctors/create endpoint
    await createDoctor(data);

    // Refresh the data on the main doctors page
    revalidatePath('/dashboard/doctors');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
    return { message: errorMessage, success: false };
  }

  // Redirect to the main list on success
  redirect('/dashboard/doctors');
}

export async function updateDoctorAction(
  prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const id = formData.get('user_id') as string;
  const data = Object.fromEntries(formData.entries());

  if (!id) {
    return { message: 'Doctor ID is missing.', success: false };
  }

  try {
    // The API endpoint is PUT /doctors/:id/profile
    await updateDoctorProfile(parseInt(id, 10), data);
    revalidatePath('/dashboard/doctors'); // Refresh the main list
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
    return { message: errorMessage, success: false };
  }

  redirect('/dashboard/doctors');
}

export async function deleteDoctorAction(formData: FormData) {
  const id = formData.get('id') as string;
  if (!id) throw new Error("Doctor ID is required.");

  try {
    // Calls DELETE /doctors/:id/account
    await deleteDoctor(parseInt(id, 10));
    revalidatePath('/dashboard/doctors');
  } catch (error) {
    console.error("Deletion failed:", error);
    // Handle error display if necessary
  }
}