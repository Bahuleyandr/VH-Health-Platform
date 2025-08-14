// src/app/(with-auth)/dashboard/admin-management/actions.ts
"use server";

import {
  createAdminUser,
  deactivateAdmin,
  reactivateAdmin,
  updateAdminPermissions,
} from "@/lib/api";
import { revalidatePath } from "next/cache";

interface FormState {
  message: string;
  success: boolean;
}

export async function createAdminAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();

  if (!email || !password || !role) {
    return {
      message: "Email, Password, and Role are required.",
      success: false,
    };
  }

  try {
    // Matches createAdminUser({ email, password, role })
    await createAdminUser({ email, password, role });
    revalidatePath("/dashboard/admin-management");
    return { message: "Admin user created successfully.", success: true };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "An unknown error occurred.";
    return { message: errorMessage, success: false };
  }
}

export async function toggleAdminStatusAction(
  formData: FormData,
): Promise<FormState> {
  const id = Number(formData.get("id"));
  const isActive = String(formData.get("is_active")) === "true";

  if (!Number.isFinite(id)) {
    return { message: "Invalid admin id.", success: false };
  }

  try {
    // Our API expects just the numeric id (no object payload)
    if (isActive) {
      await deactivateAdmin(id);
      revalidatePath("/dashboard/admin-management");
      return { message: "Admin deactivated.", success: true };
    } else {
      await reactivateAdmin(id);
      revalidatePath("/dashboard/admin-management");
      return { message: "Admin reactivated.", success: true };
    }
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Failed to toggle admin status.";
    return { message: errorMessage, success: false };
  }
}

export async function updatePermissionsAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const adminId = Number(formData.get("adminId"));
  const permissions = formData.getAll("permissions").map((p) => String(p));

  if (!Number.isFinite(adminId)) {
    return { message: "Invalid admin id.", success: false };
  }

  try {
    // Signature is (id: number, perms: string[])
    await updateAdminPermissions(adminId, permissions);
    revalidatePath("/dashboard/admin-management");
    return { message: "Permissions updated.", success: true };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Failed to update permissions.";
    return { message: errorMessage, success: false };
  }
}
