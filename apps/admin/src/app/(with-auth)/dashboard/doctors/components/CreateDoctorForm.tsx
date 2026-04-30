// src/app/(with-auth)/dashboard/doctors/components/CreateDoctorForm.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { Department } from "@/lib/types";
import Link from "next/link";
import { toast } from "sonner";

export function CreateDoctorForm({
  departments,
}: {
  departments: Department[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const formData = new FormData(e.currentTarget);
    const selectedDays = formData.getAll("available_days") as string[];
    const data = {
      name: formData.get("name") as string,
      department: formData.get("department") as string,
      specialization: formData.get("specialization") as string,
      consultation_fee: parseFloat(formData.get("consultation_fee") as string) || undefined,
      available_days: selectedDays.length > 0 ? selectedDays : undefined,
    };

    // Basic validation
    if (!data.name || !data.department || !data.specialization) {
      setError("Please fill out all required fields.");
      setLoading(false);
      return;
    }

    try {
      await fetchAdminAPI("/api/v1/doctors/admin/create", {
        method: "POST",
        body: data,
      });

      toast.success("Doctor created successfully");
      // refetchQueries (not just invalidate) so the destination page sees
      // the new row instead of the stale empty cache (60s staleTime
      // configured globally would otherwise keep "No doctors found").
      await queryClient.refetchQueries({ queryKey: ["doctors"] });
      router.push("/dashboard/doctors");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred.";
      setError(errorMessage);
      toast.error(errorMessage || "Failed to create doctor");
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      {/* Doctor Information */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-foreground mb-4">
          Doctor Information
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
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
              placeholder="Dr. John Doe"
            />
          </div>
        </div>
      </div>

      {/* Professional Information */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-foreground mb-4">
          Professional Information
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="department"
              className="block text-sm font-medium text-foreground mb-1"
            >
              Department *
            </label>
            <select
              id="department"
              name="department"
              required
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={loading}
            >
              <option value="">Select Department</option>
              {departments.map((d) => (
                <option key={d.id} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="specialization"
              className="block text-sm font-medium text-foreground mb-1"
            >
              Specialization *
            </label>
            <input
              type="text"
              id="specialization"
              name="specialization"
              required
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={loading}
              placeholder="e.g., Cardiology, Pediatrics"
            />
          </div>

          <div>
            <label
              htmlFor="consultation_fee"
              className="block text-sm font-medium text-foreground mb-1"
            >
              Consultation Fee (₹)
            </label>
            <input
              type="number"
              id="consultation_fee"
              name="consultation_fee"
              min="0"
              step="0.01"
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={loading}
              placeholder="500"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-foreground mb-2">
              Available Days
            </label>
            <div className="flex flex-wrap gap-3">
              {["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].map((day) => (
                <label key={day} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    name="available_days"
                    value={day}
                    disabled={loading}
                    className="rounded border-input"
                  />
                  <span className="text-sm text-foreground">{day.slice(0, 3)}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Form Actions */}
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={loading}
          className={`px-4 py-2 rounded-md font-medium ${
            loading
              ? "bg-muted-foreground text-muted-foreground cursor-not-allowed"
              : "bg-primary text-white hover:bg-primary/90"
          } transition-colors`}
        >
          {loading ? "Creating Doctor..." : "Create Doctor"}
        </button>
        <Link
          href="/dashboard/doctors"
          className={`text-muted-foreground hover:text-foreground ${loading ? "pointer-events-none" : ""}`}
        >
          Cancel
        </Link>
      </div>

      {error && (
        <div
          role="alert"
          className="bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded"
        >
          {error}
        </div>
      )}
    </form>
  );
}
