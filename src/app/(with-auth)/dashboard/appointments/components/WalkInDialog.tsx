"use client";

import React, { useState } from "react";
import { toast } from "react-hot-toast";
import { registerWalkInAdmin } from "@/lib/api/appointments";

export function WalkInDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (token: number) => void;
}) {
  const [patientPhone, setPatientPhone] = useState("");
  const [patientName, setPatientName] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [department, setDepartment] = useState("");
  const [reason, setReason] = useState("");
  const [time, setTime] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patientPhone && !patientName) {
      toast.error("Patient phone or name required");
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, string | number | undefined> = {
        patient_phone: patientPhone || undefined,
        patient_name: patientName || undefined,
        department: department || undefined,
        reason: reason || "Walk-in consultation",
        appointment_time: time || "Walk-in",
      };
      if (doctorId) payload.doctor_id = parseInt(doctorId);
      const res = await registerWalkInAdmin(payload);
      const token = (res as Record<string, unknown>)?.data
        ? ((res as Record<string, unknown>).data as Record<string, unknown>)?.token_number
        : (res as Record<string, unknown>)?.token_number;
      onSuccess(Number(token) || 0);
      toast.success(`Walk-in registered! Token #${token}`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to register walk-in");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-bold mb-4">Register Walk-in Patient</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-sm font-medium">Patient Phone</label>
            <input type="tel" value={patientPhone} onChange={e => setPatientPhone(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="10-digit mobile number" />
          </div>
          <div>
            <label className="text-sm font-medium">Patient Name</label>
            <input type="text" value={patientName} onChange={e => setPatientName(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="Full name" />
          </div>
          <div>
            <label className="text-sm font-medium">Doctor ID (optional)</label>
            <input type="number" value={doctorId} onChange={e => setDoctorId(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="Doctor user ID" />
          </div>
          <div>
            <label className="text-sm font-medium">Department</label>
            <input type="text" value={department} onChange={e => setDepartment(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="e.g. General Medicine" />
          </div>
          <div>
            <label className="text-sm font-medium">Appointment Time (optional)</label>
            <input type="time" value={time} onChange={e => setTime(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" />
          </div>
          <div>
            <label className="text-sm font-medium">Reason</label>
            <input type="text" value={reason} onChange={e => setReason(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="Walk-in consultation" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 border rounded px-4 py-2 text-sm hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={submitting}
              className="flex-1 bg-teal-600 text-white rounded px-4 py-2 text-sm hover:bg-teal-700 disabled:opacity-50">
              {submitting ? "Registering…" : "Register Walk-in"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
