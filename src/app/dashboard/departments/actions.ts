// src/app/dashboard/departments/actions.ts
'use server';

import { postAdminAPI } from '@/lib/api';
import { deleteAdminAPI } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

interface FormState {
  message: string;
  success: boolean;
}

export async function createDepartment(
  prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const name = formData.get('name') as string;
  const description = formData.get('description') as string;

  if (!name) {
    return { message: 'Department name is required.', success: false };
  }

  try {
    // The path comes from your adminDepartmentRoutes.js file
    await postAdminAPI('/departments/create', { name, description });

    // Refresh the data on the departments page
    revalidatePath('/dashboard/departments');
    
    return { message: `Department '${name}' created successfully.`, success: true };
  } catch (error) {
    let errorMessage = "An unknown error occurred.";
    if (error instanceof Error) {
        errorMessage = error.message;
    }
    return { message: errorMessage, success: false };
  }
}

export async function updateDepartment(
  prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const id = formData.get('id') as string;
  const name = formData.get('name') as string;
  const description = formData.get('description') as string;

  if (!name || !id) {
    return { message: 'ID and Name are required.', success: false };
  }

  try {
    // The path comes from your adminDepartmentRoutes.js file (PUT /:id)
    await putAdminAPI(`/departments/${id}`, { name, description });

    revalidatePath('/dashboard/departments'); // Refresh the main table
    // No redirect here, so the user sees the success message on the form.
    return { message: 'Department updated successfully.', success: true };
  } catch (error) {
    let errorMessage = "An unknown error occurred.";
    if (error instanceof Error) {
        errorMessage = error.message;
    }
    return { message: errorMessage, success: false };
  }
}

export async function deleteDepartment(formData: FormData) {
  const id = formData.get('id') as string;

  if (!id) {
    throw new Error("Department ID is required for deletion.");
  }

  try {
    // Assuming a DELETE /departments/:id endpoint exists, which is standard REST practice.
    await deleteAdminAPI(`/departments/${id}`);
    revalidatePath('/dashboard/departments'); // Refresh the table
  } catch (error) {
    console.error("Deletion failed:", error);
    // You could return an error message here if using useFormState
    // For a simple form, revalidating is often enough.
  }
}