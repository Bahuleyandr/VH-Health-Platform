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
  // Admin PK is UUID (uid), not a numeric id
  const uid = String(formData.get("id") ?? "").trim();
  const isActive = String(formData.get("is_active")) === "true";

  if (!uid) {
    return { message: "Invalid admin uid.", success: false };
  }

  try {
    if (isActive) {
      await deactivateAdmin(uid);
      revalidatePath("/dashboard/admin-management");
      return { message: "Admin deactivated.", success: true };
    } else {
      await reactivateAdmin(uid);
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
  // Admin PK is UUID (uid), not a numeric id
  const adminUid = String(formData.get("adminId") ?? "").trim();
  const permissions = formData.getAll("permissions").map((p) => String(p));

  if (!adminUid) {
    return { message: "Invalid admin uid.", success: false };
  }

  try {
    await updateAdminPermissions(adminUid, permissions);
    revalidatePath("/dashboard/admin-management");
    return { message: "Permissions updated.", success: true };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Failed to update permissions.";
    return { message: errorMessage, success: false };
  }
}
