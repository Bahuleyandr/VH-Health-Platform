// src/app/dashboard/admin-management/actions.ts
'use server';

import { createAdminUser } from '@/lib/api';
import { deactivateAdmin, reactivateAdmin, updateAdminPermissions } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

interface FormState {
  message: string;
  success: boolean;
}

export async function createAdminAction(
  prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const data = Object.fromEntries(formData.entries());

  if (!data.name || !data.email || !data.password) {
    return { message: 'Name, Email, and Password are required.', success: false };
  }

  try {
    // Calls POST /auth/admin/create-admin
    await createAdminUser(data);
    revalidatePath('/dashboard/admin-management');
    return { message: 'Admin user created successfully.', success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
    return { message: errorMessage, success: false };
  }
}

export async function toggleAdminStatusAction(formData: FormData) {
  const id = parseInt(formData.get('id') as string, 10);
  const isActive = formData.get('is_active') === 'true';
  const reason = "Deactivated via admin portal"; // Default reason

  try {
    if (isActive) {
      // If currently active, deactivate them
      await deactivateAdmin({ adminId: id, reason });
    } else {
      // If currently inactive, reactivate them
      await reactivateAdmin({ adminId: id });
    }
    revalidatePath('/dashboard/admin-management');
  } catch (error) {
    console.error("Failed to toggle admin status:", error);
    // You could return an error message here
  }
}

export async function updatePermissionsAction(prevState: FormState, formData: FormData): Promise<FormState> {
    const adminId = parseInt(formData.get('adminId') as string, 10);
    const permissions = formData.getAll('permissions') as string[];

    try {
        await updateAdminPermissions({ adminId, permissions });
        revalidatePath('/dashboard/admin-management');
        redirect('/dashboard/admin-management');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        return { message: errorMessage, success: false };
    }
}