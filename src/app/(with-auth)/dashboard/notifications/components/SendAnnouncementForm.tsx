// src/app/(with-auth)/dashboard/notifications/components/SendAnnouncementForm.tsx
"use client";

import { fetchAdminAPI } from "@/lib/api";
import { useState, useRef } from "react";

interface SendAnnouncementFormProps {
  onSuccess?: () => void;
}

export function SendAnnouncementForm({ onSuccess }: SendAnnouncementFormProps) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");
    setIsError(false);

    const formData = new FormData(e.currentTarget);
    const title = formData.get("title") as string;
    const body = formData.get("body") as string;

    if (!title || !body) {
      setMessage("Title and Body are required.");
      setIsError(true);
      setLoading(false);
      return;
    }

    try {
      await fetchAdminAPI("/notifications/announce", {
        method: "POST",
        body: JSON.stringify({
          title,
          message: body,
          recipients: ["all"], // You can modify this based on your needs
          priority: "normal",
        }),
      });

      setMessage("Announcement sent successfully.");
      setIsError(false);
      formRef.current?.reset();

      // Call the success callback if provided
      if (onSuccess) {
        onSuccess();
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

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="space-y-4 p-4 border rounded-lg bg-white shadow mb-6"
    >
      <h3 className="text-lg font-semibold">Send System-Wide Announcement</h3>
      <div>
        <label
          htmlFor="title"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Title
        </label>
        <input
          type="text"
          id="title"
          name="title"
          required
          className="border p-2 rounded w-full focus:ring-blue-500 focus:border-blue-500"
          disabled={loading}
        />
      </div>
      <div>
        <label
          htmlFor="body"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Message
        </label>
        <textarea
          id="body"
          name="body"
          required
          rows={4}
          className="border p-2 rounded w-full focus:ring-blue-500 focus:border-blue-500"
          disabled={loading}
        />
      </div>
      <button
        type="submit"
        disabled={loading}
        className={`px-4 py-2 rounded font-medium ${
          loading
            ? "bg-gray-400 text-gray-200 cursor-not-allowed"
            : "bg-blue-500 text-white hover:bg-blue-600"
        }`}
      >
        {loading ? "Sending..." : "Send Announcement"}
      </button>
      {message && (
        <p
          className={`mt-2 text-sm ${isError ? "text-red-600" : "text-green-600"}`}
        >
          {message}
        </p>
      )}
    </form>
  );
}
