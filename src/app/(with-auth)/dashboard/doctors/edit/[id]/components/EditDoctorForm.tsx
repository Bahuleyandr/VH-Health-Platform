// src/app/(with-auth)/dashboard/doctors/edit/[id]/components/EditDoctorForm.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchAdminAPI } from "@/lib/api";
import { Department, Doctor } from "@/lib/types";
import Link from "next/link";
import { toast } from "sonner";

interface EditDoctorFormProps {
  doctor: Doctor;
  departments: Department[];
}

export function EditDoctorForm({ doctor, departments }: EditDoctorFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const formData = new FormData(e.currentTarget);
    const data = {
      name: formData.get("name") as string,
      department: formData.get("department") as string,
      specialization: formData.get("specialization") as string,
      consultation_fee: parseInt(formData.get("consultation_fee") as string),
      is_available: formData.get("is_available") === "on",
    };

    try {
      await fetchAdminAPI(`/doctors/${doctor.user_id}/profile`, {
        method: "PUT",
        body: JSON.stringify(data),
      });

      toast.success("Doctor updated successfully");
      // Redirect to the doctors list on success
      router.push("/dashboard/doctors");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred.";
      setError(errorMessage);
      toast.error(errorMessage || "Failed to update doctor");
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-foreground mb-4">
          Professional Information
        </h2>

        {/* Professional Details */}
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
              defaultValue={doctor.name}
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={loading}
            />
          </div>

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
              defaultValue={doctor.department}
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={loading}
            >
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
              defaultValue={doctor.specialization}
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={loading}
            />
          </div>

          <div>
            <label
              htmlFor="consultation_fee"
              className="block text-sm font-medium text-foreground mb-1"
            >
              Consultation Fee (₹) *
            </label>
            <input
              type="number"
              id="consultation_fee"
              name="consultation_fee"
              required
              defaultValue={doctor.consultation_fee}
              min="0"
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
              disabled={loading}
            />
          </div>
        </div>

        {/* Availability Toggle */}
        <div className="mt-6 pt-6 border-t">
          <label className="flex items-center cursor-pointer">
            <input
              type="checkbox"
              name="is_available"
              defaultChecked={doctor.is_available}
              className="h-4 w-4 text-primary focus:ring-primary border-input rounded"
              disabled={loading}
            />
            <span className="ml-2 text-sm font-medium text-foreground">
              Available for appointments
            </span>
          </label>
        </div>
      </div>

      {/* Contact Information (Read-only) */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-foreground mb-4">
          Contact Information (Read-only)
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="email-readonly" className="block text-sm font-medium text-foreground mb-1">
              Email Address
            </label>
            <input
              type="email"
              id="email-readonly"
              value={doctor.email}
              readOnly
              className="w-full px-3 py-2 border border-input rounded-md bg-muted text-muted-foreground"
            />
          </div>
          <div>
            <label htmlFor="phone-readonly" className="block text-sm font-medium text-foreground mb-1">
              Phone Number
            </label>
            <input
              type="tel"
              id="phone-readonly"
              value={doctor.phone}
              readOnly
              className="w-full px-3 py-2 border border-input rounded-md bg-muted text-muted-foreground"
            />
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
          {loading ? "Saving Changes..." : "Save Changes"}
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
