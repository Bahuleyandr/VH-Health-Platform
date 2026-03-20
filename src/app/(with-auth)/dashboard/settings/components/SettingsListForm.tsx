// src/app/(with-auth)/dashboard/settings/components/SettingsListForm.tsx
"use client";

import { fetchAdminAPI } from "@/lib/api";
import { SystemSetting } from "@/lib/types";
import { useState } from "react";

interface SettingsListFormProps {
  settings: SystemSetting[];
  onUpdate?: () => void;
}

interface SettingRowProps {
  setting: SystemSetting;
  onUpdate?: () => void;
}

// Define proper type for input configuration
interface InputConfig {
  type: string;
  props?: Record<string, unknown>;
}

// Helper function to determine input type based on setting key or value
function getInputType(setting: SystemSetting): InputConfig {
  const key = setting.setting_key.toLowerCase();
  const value = setting.setting_value.toLowerCase();

  // Boolean settings
  if (
    value === "true" ||
    value === "false" ||
    key.includes("enable") ||
    key.includes("allow")
  ) {
    return { type: "boolean" };
  }

  // Number settings
  if (
    key.includes("limit") ||
    key.includes("max") ||
    key.includes("min") ||
    key.includes("timeout")
  ) {
    return { type: "number", props: { min: 0 } };
  }

  // Email settings
  if (key.includes("email")) {
    return { type: "email" };
  }

  // URL settings
  if (key.includes("url") || key.includes("endpoint")) {
    return { type: "url" };
  }

  // Time settings
  if (key.includes("time") && (key.includes("open") || key.includes("close"))) {
    return { type: "time" };
  }

  // Default to text
  return { type: "text" };
}

function SettingRow({ setting, onUpdate }: SettingRowProps) {
  const [value, setValue] = useState(setting.setting_value);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  const inputConfig = getInputType(setting);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");
    setIsError(false);

    try {
      await fetchAdminAPI("/system/settings", {
        method: "PUT",
        body: JSON.stringify({
          key: setting.setting_key,
          value: value,
        }),
      });

      setMessage(`Updated successfully`);
      setIsError(false);

      if (onUpdate) {
        onUpdate();
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred.";
      setMessage(errorMessage);
      setIsError(true);
    } finally {
      setLoading(false);
    }
  };

  const hasChanged = value !== setting.setting_value;

  const renderInput = () => {
    if (inputConfig.type === "boolean") {
      return (
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="border p-2 rounded-md w-full focus:ring-blue-500 focus:border-blue-500"
          disabled={loading}
        >
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </select>
      );
    }

    return (
      <input
        type={inputConfig.type}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="border p-2 rounded-md w-full focus:ring-blue-500 focus:border-blue-500"
        disabled={loading}
        {...inputConfig.props}
      />
    );
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start"
    >
      <div>
        <label className="font-semibold text-gray-700 block">
          {setting.setting_key
            .replace(/_/g, " ")
            .replace(/\b\w/g, (l) => l.toUpperCase())}
        </label>
        <p className="text-sm text-gray-500 mt-1">
          {setting.description ||
            `Configure ${setting.setting_key.replace(/_/g, " ")}`}
        </p>
      </div>

      <div>{renderInput()}</div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={loading || !hasChanged}
          className={`px-4 py-2 rounded-md font-medium transition-colors ${
            loading || !hasChanged
              ? "bg-gray-300 text-gray-500 cursor-not-allowed"
              : "bg-blue-500 text-white hover:bg-blue-600"
          }`}
        >
          {loading ? "Saving..." : "Save"}
        </button>
        {hasChanged && !loading && (
          <span className="text-sm text-orange-600">•</span>
        )}
        {message && !hasChanged && (
          <p
            className={`text-sm ${isError ? "text-red-600" : "text-green-600"}`}
          >
            {message}
          </p>
        )}
      </div>
    </form>
  );
}

export function SettingsListForm({
  settings,
  onUpdate,
}: SettingsListFormProps) {
  // Group settings by category (based on key prefix)
  const groupedSettings = settings.reduce(
    (acc, setting) => {
      const category = setting.setting_key.split("_")[0].toUpperCase();
      if (!acc[category]) acc[category] = [];
      acc[category].push(setting);
      return acc;
    },
    {} as Record<string, SystemSetting[]>,
  );

  return (
    <div className="space-y-6">
      {Object.keys(groupedSettings).length === 0 ? (
        <div className="bg-white p-8 rounded-lg shadow text-center">
          <p className="text-gray-500">No settings available</p>
        </div>
      ) : (
        Object.entries(groupedSettings).map(([category, categorySettings]) => (
          <div key={category} className="bg-white p-6 rounded-lg shadow">
            <h3 className="text-lg font-semibold text-gray-800 mb-4 pb-4 border-b">
              {category} Settings
            </h3>
            <div className="space-y-6">
              {categorySettings.map((setting) => (
                <SettingRow
                  key={setting.setting_key}
                  setting={setting}
                  onUpdate={onUpdate}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
