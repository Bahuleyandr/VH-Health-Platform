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

const DAYS_OF_WEEK = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

type DaySchedule = { start: string; end: string };
type ScheduleMap = Record<string, DaySchedule>;

function parseSchedule(doctor: Doctor): {
  enabledDays: Set<string>;
  hours: ScheduleMap;
} {
  const raw = doctor as Record<string, unknown>;
  const availDays = (raw.available_days as string[] | undefined) ?? [];
  const availHours = (raw.available_hours as ScheduleMap | undefined) ?? {};

  const enabledDays = new Set(availDays);
  const hours: ScheduleMap = {};
  for (const day of DAYS_OF_WEEK) {
    hours[day] = availHours[day] ?? { start: "09:00", end: "17:00" };
  }
  return { enabledDays, hours };
}

export function EditDoctorForm({ doctor, departments }: EditDoctorFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const raw = doctor as Record<string, unknown>;
  const initial = parseSchedule(doctor);

  const [enabledDays, setEnabledDays] = useState<Set<string>>(
    initial.enabledDays,
  );
  const [hours, setHours] = useState<ScheduleMap>(initial.hours);
  const [bio, setBio] = useState((raw.bio as string) ?? "");
  const [education, setEducation] = useState((raw.education as string) ?? "");
  const [qualifications, setQualifications] = useState(
    ((raw.qualifications as string[]) ?? []).join(", "),
  );
  const [experienceYears, setExperienceYears] = useState(
    (raw.experience_years as number) ?? 0,
  );

  const toggleDay = (day: string) => {
    setEnabledDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  };

  const setDayTime = (
    day: string,
    field: "start" | "end",
    value: string,
  ) => {
    setHours((prev) => ({
      ...prev,
      [day]: { ...prev[day], [field]: value },
    }));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const formData = new FormData(e.currentTarget);

    // Build available_hours from enabled days only
    const availableHours: ScheduleMap = {};
    for (const day of Array.from(enabledDays)) {
      availableHours[day] = hours[day];
    }

    const profileData = {
      name: formData.get("name") as string,
      department: formData.get("department") as string,
      specialization: formData.get("specialization") as string,
      consultation_fee: parseFloat(formData.get("consultation_fee") as string) || undefined,
      experience_years: experienceYears,
      bio,
      education,
      qualifications: qualifications
        .split(",")
        .map((q) => q.trim())
        .filter(Boolean),
      email: (formData.get("email") as string) || undefined,
      phone: (formData.get("phone") as string) || undefined,
    };

    const availabilityData = {
      is_available: formData.get("is_available") === "on",
      available_days: Array.from(enabledDays),
      available_hours: availableHours,
    };

    try {
      // Update profile → /api/v1/doctors/:id/profile
      await fetchAdminAPI(`/doctors/${doctor.user_id}/profile`, {
        method: "PUT",
        body: profileData,
      });

      // Update availability → /api/v1/doctors/:id/availability
      await fetchAdminAPI(`/doctors/${doctor.user_id}/availability`, {
        method: "PUT",
        body: availabilityData,
      });

      toast.success("Doctor updated successfully");
      router.push("/dashboard/doctors");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "An unknown error occurred.";
      setError(errorMessage);
      toast.error(errorMessage || "Failed to update doctor");
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-3xl">
      {/* Professional Information */}
      <div className="bg-white dark:bg-card shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-foreground mb-4">
          Professional Information
        </h2>

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
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-background"
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
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-background"
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
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-background"
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
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-background"
              disabled={loading}
            />
          </div>

          <div>
            <label
              htmlFor="experience_years"
              className="block text-sm font-medium text-foreground mb-1"
            >
              Experience (years)
            </label>
            <input
              type="number"
              id="experience_years"
              min="0"
              max="60"
              value={experienceYears}
              onChange={(e) =>
                setExperienceYears(parseInt(e.target.value) || 0)
              }
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-background"
              disabled={loading}
            />
          </div>

          <div>
            <label
              htmlFor="qualifications"
              className="block text-sm font-medium text-foreground mb-1"
            >
              Qualifications
            </label>
            <input
              type="text"
              id="qualifications"
              value={qualifications}
              onChange={(e) => setQualifications(e.target.value)}
              placeholder="MBBS, MD, DM Cardiology"
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-background"
              disabled={loading}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Comma-separated list
            </p>
          </div>
        </div>

        <div className="mt-4">
          <label
            htmlFor="education"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Education
          </label>
          <input
            type="text"
            id="education"
            value={education}
            onChange={(e) => setEducation(e.target.value)}
            placeholder="MD (General Medicine), DM (Cardiology) - Madras Medical College"
            className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-background"
            disabled={loading}
          />
        </div>

        <div className="mt-4">
          <label
            htmlFor="bio"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Bio
          </label>
          <textarea
            id="bio"
            rows={3}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Brief bio about the doctor..."
            className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-background"
            disabled={loading}
          />
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

      {/* Schedule Editor */}
      <div className="bg-white dark:bg-card shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-foreground mb-4">
          Weekly Schedule
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          Toggle days and set consulting hours for each day.
        </p>

        <div className="space-y-3">
          {DAYS_OF_WEEK.map((day) => {
            const isEnabled = enabledDays.has(day);
            return (
              <div
                key={day}
                className={`flex items-center gap-4 p-3 rounded-lg border ${
                  isEnabled
                    ? "border-primary/30 bg-primary/5"
                    : "border-input bg-muted/30"
                }`}
              >
                <label className="flex items-center cursor-pointer min-w-[120px]">
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={() => toggleDay(day)}
                    className="h-4 w-4 text-primary focus:ring-primary border-input rounded"
                    disabled={loading}
                  />
                  <span
                    className={`ml-2 text-sm font-medium ${
                      isEnabled
                        ? "text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    {day}
                  </span>
                </label>

                {isEnabled && (
                  <div className="flex items-center gap-2 text-sm">
                    <input
                      type="time"
                      value={hours[day]?.start ?? "09:00"}
                      onChange={(e) =>
                        setDayTime(day, "start", e.target.value)
                      }
                      className="px-2 py-1 border border-input rounded-md bg-background text-foreground"
                      disabled={loading}
                    />
                    <span className="text-muted-foreground">to</span>
                    <input
                      type="time"
                      value={hours[day]?.end ?? "17:00"}
                      onChange={(e) =>
                        setDayTime(day, "end", e.target.value)
                      }
                      className="px-2 py-1 border border-input rounded-md bg-background text-foreground"
                      disabled={loading}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Contact Information (Read-only) */}
      <div className="bg-white dark:bg-card shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-foreground mb-4">
          Contact Information (Read-only)
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-foreground mb-1"
            >
              Email Address
            </label>
            <input
              type="email"
              id="email"
              name="email"
              defaultValue={doctor.email ?? ""}
              disabled={loading}
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div>
            <label
              htmlFor="phone"
              className="block text-sm font-medium text-foreground mb-1"
            >
              Phone Number
            </label>
            <input
              type="tel"
              id="phone"
              name="phone"
              defaultValue={doctor.phone ?? ""}
              disabled={loading}
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
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
