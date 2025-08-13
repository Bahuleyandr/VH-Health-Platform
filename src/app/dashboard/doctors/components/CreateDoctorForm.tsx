// src/app/dashboard/doctors/components/CreateDoctorForm.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchAdminAPI } from "@/lib/api";
import { Department } from "@/lib/types";
import Link from "next/link";

export function CreateDoctorForm({
  departments,
}: {
  departments: Department[];
}) {
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
      email: formData.get("email") as string,
      password: formData.get("password") as string,
      phone: formData.get("phone") as string,
      department: formData.get("department") as string,
      specialization: formData.get("specialization") as string,
      consultation_fee: parseInt(formData.get("consultation_fee") as string),
    };

    // Basic validation
    if (
      !data.name ||
      !data.email ||
      !data.password ||
      !data.phone ||
      !data.department ||
      !data.specialization
    ) {
      setError("Please fill out all required fields.");
      setLoading(false);
      return;
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      setError("Please enter a valid email address.");
      setLoading(false);
      return;
    }

    // Phone validation (10 digits)
    const phoneRegex = /^[0-9]{10}$/;
    if (!phoneRegex.test(data.phone)) {
      setError("Please enter a valid 10-digit phone number.");
      setLoading(false);
      return;
    }

    try {
      await fetchAdminAPI("/doctors", {
        method: "POST",
        body: JSON.stringify(data),
      });

      // Redirect to the doctors list on success
      router.push("/dashboard/doctors");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred.";
      setError(errorMessage);
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      {/* Personal Information */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-gray-900 mb-4">
          Personal Information
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Full Name *
            </label>
            <input
              type="text"
              id="name"
              name="name"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              disabled={loading}
              placeholder="Dr. John Doe"
            />
          </div>

          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Email Address *
            </label>
            <input
              type="email"
              id="email"
              name="email"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              disabled={loading}
              placeholder="doctor@example.com"
            />
          </div>

          <div>
            <label
              htmlFor="phone"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Phone Number *
            </label>
            <input
              type="tel"
              id="phone"
              name="phone"
              required
              pattern="[0-9]{10}"
              placeholder="9876543210"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              disabled={loading}
            />
            <p className="mt-1 text-xs text-gray-500">
              10 digit number without country code
            </p>
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Password *
            </label>
            <input
              type="password"
              id="password"
              name="password"
              required
              minLength={8}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              disabled={loading}
              placeholder="Minimum 8 characters"
            />
          </div>
        </div>
      </div>

      {/* Professional Information */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-gray-900 mb-4">
          Professional Information
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="department"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Department *
            </label>
            <select
              id="department"
              name="department"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Specialization *
            </label>
            <input
              type="text"
              id="specialization"
              name="specialization"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              disabled={loading}
              placeholder="e.g., Cardiology, Pediatrics"
            />
          </div>

          <div>
            <label
              htmlFor="consultation_fee"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Consultation Fee (₹) *
            </label>
            <input
              type="number"
              id="consultation_fee"
              name="consultation_fee"
              required
              min="0"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              disabled={loading}
              placeholder="500"
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
              ? "bg-gray-400 text-gray-200 cursor-not-allowed"
              : "bg-blue-600 text-white hover:bg-blue-700"
          } transition-colors`}
        >
          {loading ? "Creating Doctor..." : "Create Doctor"}
        </button>
        <Link
          href="/dashboard/doctors"
          className={`text-gray-500 hover:text-gray-700 ${loading ? "pointer-events-none" : ""}`}
        >
          Cancel
        </Link>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}
    </form>
  );
}
