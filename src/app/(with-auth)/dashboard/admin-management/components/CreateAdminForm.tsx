// src/app/(with-auth)/dashboard/admin-management/components/CreateAdminForm.tsx
"use client";

import { useState, useEffect } from "react";
import { postJSON } from "@/lib/api";
import { API_ENDPOINTS } from "@/lib/api-config";

interface CreateAdminFormProps {
  onAdminCreated?: () => void;
}

export function CreateAdminForm({ onAdminCreated }: CreateAdminFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Clear success message after 5 seconds
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");

    const formData = new FormData(e.currentTarget);
    const data = {
      name: formData.get("name") as string,
      email: formData.get("email") as string,
      password: formData.get("password") as string,
      role: formData.get("role") as string,
    };

    // Basic validation
    if (!data.name || !data.email || !data.password) {
      setError("Name, Email, and Password are required.");
      setLoading(false);
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      setError("Please enter a valid email address.");
      setLoading(false);
      return;
    }

    if (data.password.length < 8) {
      setError("Password must be at least 8 characters long.");
      setLoading(false);
      return;
    }

    try {
      // Use centralized endpoint that supports POST for admin creation
      await postJSON(API_ENDPOINTS.auth.adminManagement, data);

      setSuccess("Admin user created successfully!");
      e.currentTarget.reset();

      if (onAdminCreated) onAdminCreated();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "An unknown error occurred.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 p-6 border rounded-lg bg-white shadow"
    >
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-foreground">
          Add New Administrator
        </h3>
        <span className="text-xs text-muted-foreground">* Required fields</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="name"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Full Name *
          </label>
          <input
            type="text"
            id="name"
            name="name"
            required
            className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
            disabled={loading}
            placeholder="John Doe"
          />
        </div>

        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Email Address *
          </label>
          <input
            type="email"
            id="email"
            name="email"
            required
            className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
            disabled={loading}
            placeholder="admin@vhhealth.app"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Password *
          </label>
          <input
            type="password"
            id="password"
            name="password"
            required
            minLength={8}
            className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
            disabled={loading}
            placeholder="Minimum 8 characters"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Must be at least 8 characters long
          </p>
        </div>

        <div>
          <label
            htmlFor="role"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Role *
          </label>
          <select
            id="role"
            name="role"
            required
            className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
            disabled={loading}
            defaultValue="ADMIN"
          >
            <option value="ADMIN">Admin</option>
            <option value="SUPER_ADMIN">Super Admin</option>
          </select>
        </div>
      </div>

      <div>
        <button
          type="submit"
          disabled={loading}
          className={`px-4 py-2 rounded-md font-medium transition-colors ${
            loading
              ? "bg-muted-foreground text-muted-foreground cursor-not-allowed"
              : "bg-primary text-white hover:bg-primary/90"
          }`}
        >
          {loading ? "Creating..." : "Create Admin"}
        </button>
      </div>

      {success && (
        <div className="bg-success/10 border border-success text-success px-4 py-3 rounded">
          {success}
        </div>
      )}

      {error && (
        <div className="bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded">
          {error}
        </div>
      )}
    </form>
  );
}
