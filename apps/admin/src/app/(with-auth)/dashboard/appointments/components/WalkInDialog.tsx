"use client";

import React, { useState } from "react";
import { toast } from "react-hot-toast";
import { useQuery } from "@tanstack/react-query";
import { registerWalkInAdmin } from "@/lib/api/appointments";
import { fetchAdminAPI } from "@/lib/api";

interface DoctorOption {
  id: number;
  // `user_id` is the canonical identifier the booking endpoint stores in
  // appointments.doctor_id. When `assignable=true` is requested the
  // backend INNER-joins users.role='DOCTOR' so user_id is always set;
  // submit it (not id, which is the doctors row PK) so seed rows whose
  // doctors.id collides with an OBGYN/PATIENT users.id can't misroute
  // the visit. See finding
  // 2026-05-10-pediatric-opd-receptionist-doctor-dropdown-misroutes-paeds.
  user_id?: number;
  name?: string;
  department?: string;
  specialization?: string;
}

interface DepartmentOption {
  id?: number;
  name: string;
}

export function WalkInDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (token: number) => void;
}) {
  const [patientPhone, setPatientPhone] = useState("");
  const [patientName, setPatientName] = useState("");
  // Demographics — DOB / gender / address let us register a complete
  // patient record on first contact instead of forcing the doctor to
  // re-collect at consult. See finding
  // 2026-05-08-walk-in-opd-receptionist-walkin-dialog-missing-demographics.
  const [patientDob, setPatientDob] = useState("");
  const [patientGender, setPatientGender] = useState("");
  const [patientAddress, setPatientAddress] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [department, setDepartment] = useState("");
  const [reason, setReason] = useState("");
  const [time, setTime] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Paediatric mode kicks in when the DOB resolves to under 12 years —
  // the dropdown then asks the backend for paediatricians + general
  // 'all-ages' consultants. Same age threshold used by the backend's
  // weight-based dose check. Finding:
  // 2026-05-10-pediatric-opd-receptionist-doctor-dropdown-misroutes-paeds.
  const isPaediatric = (() => {
    if (!patientDob) return false;
    const dob = new Date(patientDob);
    if (Number.isNaN(dob.getTime())) return false;
    const ageYears = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    return ageYears >= 0 && ageYears < 12;
  })();

  // Doctor dropdown — pass `assignable=true` so the backend INNER-joins
  // users.role='DOCTOR' and excludes seed rows whose doctors.user_id
  // points to a PATIENT placeholder. The default limit of 10 silently
  // hid half the roster, so request 200 explicitly. Department + paeds
  // age filter narrow the list to the right consultants when the
  // receptionist has already chosen them. Findings:
  //   2026-05-08-walk-in-opd-receptionist-walkin-dialog-doctor-dropdown-truncated-at-10
  //   2026-05-10-walk-in-opd-receptionist-doctor-roster-not-assignable
  //   2026-05-10-pediatric-opd-receptionist-doctor-dropdown-misroutes-paeds
  //   2026-05-11-pediatric-opd-receptionist-19ac24e8
  //   2026-05-11-dynamic-acute-abdomen-receptionist-3d9eb5b9
  const doctorQueryParams = (() => {
    const parts = ["limit=200", "assignable=true"];
    if (department) parts.push(`department=${encodeURIComponent(department)}`);
    if (isPaediatric) parts.push("ageRange=paediatric");
    return parts.join("&");
  })();
  const { data: doctorsResp } = useQuery({
    queryKey: ["doctors", { limit: 200, assignable: true, department, isPaediatric }],
    queryFn: () => fetchAdminAPI<unknown>(`/doctors?${doctorQueryParams}`),
  });
  const doctorsList: DoctorOption[] = (() => {
    const raw = doctorsResp as Record<string, unknown> | unknown[] | undefined;
    if (Array.isArray(raw)) return raw as DoctorOption[];
    if (raw && typeof raw === "object" && Array.isArray((raw as { doctors?: unknown }).doctors)) {
      return (raw as { doctors: DoctorOption[] }).doctors;
    }
    return [];
  })();

  // Department dropdown — the field used to be a free-text input which
  // let operators silently store misspellings ("Gen Medicine", "general
  // med") that broke department-grouped reporting. Bind to the canonical
  // /departments list. See finding
  // 2026-05-08-walk-in-opd-receptionist-walkin-dialog-department-is-free-text.
  const { data: departmentsResp } = useQuery({
    queryKey: ["departments", { limit: 200 }],
    queryFn: () => fetchAdminAPI<unknown>("/departments?limit=200"),
  });
  const departmentsList: DepartmentOption[] = (() => {
    const raw = departmentsResp as Record<string, unknown> | unknown[] | undefined;
    if (Array.isArray(raw)) return raw as DepartmentOption[];
    if (raw && typeof raw === "object") {
      const wrapper = raw as { departments?: unknown; data?: unknown };
      if (Array.isArray(wrapper.departments)) return wrapper.departments as DepartmentOption[];
      if (Array.isArray(wrapper.data)) return wrapper.data as DepartmentOption[];
    }
    return [];
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Backend requires patient_phone OR patient_id — name alone is not enough.
    // Previously the guard only fired when BOTH were empty, so a name-only
    // submit travelled to the backend and bounced back with the raw API
    // contract message. See finding
    // 2026-05-08-walk-in-opd-receptionist-walkin-dialog-misleading-validation.
    if (!patientPhone) {
      toast.error("Mobile number is required");
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, string | number | undefined> = {
        patient_phone: patientPhone || undefined,
        patient_name: patientName || undefined,
        patient_birthday: patientDob || undefined,
        patient_gender: patientGender || undefined,
        patient_address: patientAddress || undefined,
        department: department || undefined,
        reason: reason || "Walk-in consultation",
        appointment_time: time || "Walk-in",
      };
      // doctorId carries the canonical users.id (assignable mode populates
      // option.value with d.user_id) — that's what appointments.doctor_id
      // expects. The booking endpoint still accepts the legacy doctors.id
      // via a UNION ALL fallback, but submitting users.id avoids the
      // ambiguous resolution path entirely.
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">DOB</label>
              <input type="date" value={patientDob} onChange={e => setPatientDob(e.target.value)}
                className="w-full border rounded px-3 py-2 text-sm mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">Gender</label>
              <select value={patientGender} onChange={e => setPatientGender(e.target.value)}
                className="w-full border rounded px-3 py-2 text-sm mt-1 bg-white">
                <option value="">— Select —</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Address (optional)</label>
            <input type="text" value={patientAddress} onChange={e => setPatientAddress(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="Street, area, city" />
          </div>
          <div>
            <label className="text-sm font-medium">Doctor (optional)</label>
            <select
              value={doctorId}
              onChange={e => setDoctorId(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1 bg-white"
            >
              <option value="">— Unassigned —</option>
              {doctorsList.map((d) => {
                const submitId = d.user_id ?? d.id;
                return (
                  <option key={d.id} value={submitId}>
                    {d.name || `Doctor #${submitId}`}
                    {d.department ? ` · ${d.department}` : ""}
                    {d.specialization ? ` (${d.specialization})` : ""}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Department</label>
            <select
              value={department}
              onChange={e => setDepartment(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1 bg-white"
            >
              <option value="">— Select department —</option>
              {departmentsList.map((d, idx) => (
                <option key={d.id ?? `dept-${idx}-${d.name}`} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
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
