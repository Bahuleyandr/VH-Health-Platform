"use client";

import React, { useEffect, useMemo, useState } from "react";
import { toast } from "react-hot-toast";
import { useQuery } from "@tanstack/react-query";
import { bookAppointmentAdmin } from "@/lib/api/appointments";
import { fetchAdminAPI } from "@/lib/api";

interface DoctorOption {
  // /appointments/doctors/options returns `id` set to users.id (the
  // canonical doctor identifier downstream booking stores). Doctors
  // whose users.role isn't 'DOCTOR' are filtered out by the backend
  // INNER JOIN so picker options are always bookable. Wave-3 doctor
  // roster fix (2026-05-12).
  id: number;
  user_id?: number;
  doctor_row_id?: number;
  name?: string;
  department?: string;
  specialization?: string;
}

interface DoctorListResponse {
  doctors?: DoctorOption[];
  pagination?: {
    page?: number;
    totalPages?: number;
    hasNext?: boolean;
  };
}

interface PatientOption {
  id: number;
  uid?: string;
  name?: string;
  phone?: string;
}

interface PatientSearchResponse {
  patients?: PatientOption[];
}

function digitsOnly(value: string | undefined | null) {
  return (value ?? "").replace(/\D/g, "");
}

function unwrapDoctors(resp: DoctorListResponse | DoctorOption[] | undefined) {
  if (Array.isArray(resp)) return resp;
  return Array.isArray(resp?.doctors) ? resp.doctors : [];
}

async function fetchDoctorOptions() {
  const first = await fetchAdminAPI<DoctorListResponse>(
    "/appointments/doctors/options?page=1&limit=100",
  );
  const firstDoctors = unwrapDoctors(first);
  const totalPages = Math.max(1, Number(first.pagination?.totalPages ?? 1));

  if (totalPages === 1) {
    return firstDoctors;
  }

  const remaining = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_unused, index) =>
      fetchAdminAPI<DoctorListResponse>(
        `/appointments/doctors/options?page=${index + 2}&limit=100`,
      ),
    ),
  );

  return [firstDoctors, ...remaining.map(unwrapDoctors)]
    .flat()
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

export function BookAppointmentDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [patientId, setPatientId] = useState<number | null>(null);
  const [patientPhone, setPatientPhone] = useState("");
  const [patientName, setPatientName] = useState("");
  const [patientLookupStatus, setPatientLookupStatus] = useState<
    "idle" | "checking" | "found" | "new" | "error"
  >("idle");
  const [doctorId, setDoctorId] = useState("");
  const [date, setDate] = useState(today);
  const [time, setTime] = useState("10:00");
  const [visitType, setVisitType] = useState<
    "NEW" | "FOLLOW_UP" | "TELE"
  >("NEW");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: doctorsList = [], isLoading: doctorsLoading } = useQuery({
    queryKey: ["appointment-doctor-options"],
    queryFn: fetchDoctorOptions,
  });

  useEffect(() => {
    const last10 = digitsOnly(patientPhone).slice(-10);
    setPatientId(null);

    if (last10.length < 10) {
      setPatientLookupStatus("idle");
      return;
    }

    setPatientLookupStatus("checking");
    const handle = window.setTimeout(async () => {
      try {
        const result = await fetchAdminAPI<PatientSearchResponse>(
          `/patients/search?q=${encodeURIComponent(patientPhone)}&limit=10`,
        );
        const exact = (result.patients ?? []).find((patient) =>
          digitsOnly(patient.phone).endsWith(last10),
        );
        if (exact?.id) {
          setPatientId(exact.id);
          setPatientName(exact.name ?? "");
          setPatientLookupStatus("found");
        } else {
          setPatientLookupStatus("new");
        }
      } catch {
        setPatientLookupStatus("error");
      }
    }, 450);

    return () => window.clearTimeout(handle);
  }, [patientPhone]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsedDoctorId = Number(doctorId);
    const phoneDigits = digitsOnly(patientPhone);
    if (phoneDigits.length < 10) {
      toast.error("Valid patient phone required");
      return;
    }
    if (patientLookupStatus === "checking" || patientLookupStatus === "error") {
      toast.error("Patient lookup must succeed before booking");
      return;
    }
    if (!patientId && patientName.trim().length < 2) {
      toast.error("Patient name required for new patients");
      return;
    }
    if (!Number.isInteger(parsedDoctorId) || parsedDoctorId < 1) {
      toast.error("Valid doctor required");
      return;
    }
    if (reason.trim().length < 3) {
      toast.error("Reason must be at least 3 characters");
      return;
    }

    setSubmitting(true);
    try {
      await bookAppointmentAdmin({
        ...(patientId
          ? { patient_id: patientId }
          : {
              patient_phone: patientPhone.trim(),
              patient_name: patientName.trim(),
            }),
        doctor_id: parsedDoctorId,
        appointment_date: date,
        appointment_time: time,
        reason: reason.trim(),
        notes: notes.trim() || undefined,
        visit_type: visitType,
      });
      toast.success("Appointment booked");
      onSuccess();
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to book appointment",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-card p-6 text-card-foreground shadow-xl">
        <h3 className="mb-4 text-lg font-bold">Book Appointment</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-sm font-medium">Patient Phone</label>
            <input
              type="tel"
              value={patientPhone}
              onChange={(event) => setPatientPhone(event.target.value)}
              className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
              placeholder="10 digit mobile number"
            />
            <p className="mt-1 min-h-5 text-xs text-muted-foreground">
              {patientLookupStatus === "checking" &&
                "Checking patient registry..."}
              {patientLookupStatus === "found" &&
                patientId &&
                `Existing patient found: #${patientId}`}
              {patientLookupStatus === "new" &&
                "New patient - enter name to register while booking."}
              {patientLookupStatus === "error" &&
                "Could not check patient now; new-patient booking is still available."}
            </p>
          </div>

          <div>
            <label className="text-sm font-medium">Patient Name</label>
            <input
              type="text"
              value={patientName}
              readOnly={patientLookupStatus === "found"}
              onChange={(event) => setPatientName(event.target.value)}
              className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm read-only:bg-muted"
              placeholder={
                patientLookupStatus === "found"
                  ? "Pulled from backend"
                  : "Required for new patient"
              }
            />
          </div>

          <div>
            <label className="text-sm font-medium">Doctor</label>
            <select
              value={doctorId}
              onChange={(event) => setDoctorId(event.target.value)}
              className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
            >
              <option value="">Select doctor</option>
              {doctorsLoading && <option value="">Loading doctors...</option>}
              {doctorsList.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.name || `Doctor #${doctor.id}`}
                  {doctor.department ? ` - ${doctor.department}` : ""}
                  {doctor.specialization ? ` (${doctor.specialization})` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Date</label>
              <input
                type="date"
                min={today}
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Time</label>
              <input
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Visit Type</label>
            <select
              value={visitType}
              onChange={(event) =>
                setVisitType(event.target.value as "NEW" | "FOLLOW_UP" | "TELE")
              }
              className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
            >
              <option value="NEW">New consultation</option>
              <option value="FOLLOW_UP">Follow-up</option>
              <option value="TELE">Teleconsult - video visit</option>
            </select>
          </div>

          <div>
            <label className="text-sm font-medium">Reason</label>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
              rows={3}
              placeholder="Consultation reason"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Notes</label>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
              rows={2}
              placeholder="Optional"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded border px-4 py-2 text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 rounded bg-teal-600 px-4 py-2 text-sm text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {submitting ? "Booking..." : "Book"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
