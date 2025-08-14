// src/app/(with-auth)/dashboard/settings/actions.ts
"use server";

import { updateSystemSetting } from "@/lib/api";
import { revalidatePath } from "next/cache";

interface FormState {
  message: string;
  success: boolean;
  key?: string; // To track which setting was updated
}

export async function updateSettingAction(
  prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const key = formData.get("setting_key") as string;
  const value = formData.get("setting_value") as string;

  if (!key || value === null) {
    return { message: "Key and Value are required.", success: false };
  }

  try {
    await updateSystemSetting(key, { value });

    revalidatePath("/dashboard/settings");

    return {
      message: `Setting '${key}' updated successfully.`,
      success: true,
      key,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred.";
    return { message: errorMessage, success: false, key };
  }
}
