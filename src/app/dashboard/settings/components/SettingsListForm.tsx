// src/app/dashboard/settings/components/SettingsListForm.tsx
'use client';

import { SystemSetting } from "@/lib/types";
import { useFormState, useFormStatus } from "react-dom";
import { updateSettingAction } from "../actions";

const initialState = { message: '', success: false, key: '' };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="bg-blue-500 text-white px-4 py-2 rounded-md">
      {pending ? 'Saving...' : 'Save'}
    </button>
  );
}

function SettingRow({ setting }: { setting: SystemSetting }) {
  const [state, formAction] = useFormState(updateSettingAction, initialState);

  return (
    <form action={formAction} className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
      <input type="hidden" name="setting_key" value={setting.setting_key} />
      <div>
        <label className="font-semibold text-gray-700">{setting.setting_key}</label>
        <p className="text-sm text-gray-500">{setting.description}</p>
      </div>
      <input
        type="text"
        name="setting_value"
        defaultValue={setting.setting_value}
        className="border p-2 rounded-md w-full"
      />
      <div className="flex items-center gap-4">
        <SubmitButton />
        {state?.key === setting.setting_key && state.message && (
          <p className={`text-sm ${state.success ? 'text-green-600' : 'text-red-600'}`}>{state.message}</p>
        )}
      </div>
    </form>
  );
}

export function SettingsListForm({ settings }: { settings: SystemSetting[] }) {
  return (
    <div className="bg-white p-6 rounded-lg shadow space-y-6 divide-y divide-gray-200">
      {settings.map(setting => (
        <div key={setting.setting_key} className="pt-6 first:pt-0">
          <SettingRow setting={setting} />
        </div>
      ))}
    </div>
  );
}