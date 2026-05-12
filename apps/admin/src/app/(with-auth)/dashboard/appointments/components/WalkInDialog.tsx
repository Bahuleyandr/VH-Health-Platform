"use client";

import React, { useMemo, useState } from "react";
import { toast } from "react-hot-toast";
import { useQuery } from "@tanstack/react-query";
import { registerWalkInAdmin, type WalkInPayload } from "@/lib/api/appointments";
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

const ANC_DEPT_KEYWORDS = ["obgyn", "obstetrics", "anc", "gyna"];
const PAEDS_DEPT_KEYWORDS = ["paed", "pedi", "neonat"];
const ER_DEPT_KEYWORDS = ["emergency", "emer", "casualty"];

function matchesAny(deptName: string, keywords: string[]): boolean {
  const norm = deptName.trim().toLowerCase();
  return keywords.some(k => norm.includes(k));
}

// Compute age in years from a yyyy-mm-dd birthday string. Returns null if
// the string is not a recognisable date. The dialog uses this to decide
// whether to surface the guardian section — anything under 18 is a minor
// and requires legal-consent linkage at intake.
function computeAgeYears(birthday: string): number | null {
  if (!birthday || !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return null;
  const dob = new Date(birthday);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) {
    age -= 1;
  }
  return age;
}

// Estimated gestational age (weeks) from LMP — Naegele's rule.
function computeGaWeeks(lmpDate: string): number | null {
  if (!lmpDate || !/^\d{4}-\d{2}-\d{2}$/.test(lmpDate)) return null;
  const lmp = new Date(lmpDate);
  if (Number.isNaN(lmp.getTime())) return null;
  const days = Math.floor((Date.now() - lmp.getTime()) / 86400_000);
  if (days < 0 || days > 320) return null;
  return Math.floor(days / 7);
}

// EDD = LMP + 280 days. Matches the backend's computedEdd in
// registerWalkIn — the admin computes it client-side so the receptionist
// can sanity-check the date before submit.
function computeEdd(lmpDate: string): string | null {
  if (!lmpDate || !/^\d{4}-\d{2}-\d{2}$/.test(lmpDate)) return null;
  const lmp = new Date(lmpDate);
  if (Number.isNaN(lmp.getTime())) return null;
  return new Date(lmp.getTime() + 280 * 86400_000).toISOString().slice(0, 10);
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
  // Wave-3 batch-2 — weight at intake. Required for paediatric
  // weight-based dosing safety checks downstream. Finding:
  // 2026-05-08-pediatric-opd-receptionist-no-dob-no-gender-walkin.
  const [patientWeightKg, setPatientWeightKg] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [department, setDepartment] = useState("");
  const [reason, setReason] = useState("");
  const [time, setTime] = useState("");
  // Wave-3 batch-2 — guardian section, surfaced when the DOB indicates
  // the patient is a minor. Findings:
  //   2026-05-08-pediatric-opd-receptionist-no-guardian-model
  //   2026-05-10-pediatric-opd-receptionist-minor-guardian-id-not-structured
  //   2026-05-11-pediatric-opd-receptionist-7501ae08
  const [guardianName, setGuardianName] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [guardianRelationship, setGuardianRelationship] = useState("");
  const [guardianIdType, setGuardianIdType] = useState("");
  const [guardianIdReference, setGuardianIdReference] = useState("");
  // Finding 2026-05-09-pediatric-opd-patient-no-dependent-profile — link
  // the minor row to the guardian's own users row when the guardian
  // already has an account. The receptionist can paste the existing
  // user's int id; the backend stores it on users.guardian_user_id
  // (self-FK).
  const [guardianUserId, setGuardianUserId] = useState("");
  // ANC section, surfaced when the department routes to OBGYN/ANC.
  // Findings:
  //   2026-05-08-obstetric-anc-receptionist-walkin-drops-anc-fields
  //   2026-05-10-obstetric-anc-receptionist-walkin-ui-no-anc-fields
  const [lmpDate, setLmpDate] = useState("");
  const [gravida, setGravida] = useState("");
  const [parity, setParity] = useState("");
  const [livingChildren, setLivingChildren] = useState("");
  const [abortions, setAbortions] = useState("");
  // Unidentified-ER mode. Surfaced when the department routes to
  // EMERGENCY. Finding:
  //   2026-05-09-emergency-walk-in-receptionist-no-phone-optional-er-path
  const [isUnidentified, setIsUnidentified] = useState(false);
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

  const ageYears = useMemo(() => computeAgeYears(patientDob), [patientDob]);
  const isMinor = ageYears !== null && ageYears < 18;
  const showAncSection = matchesAny(department, ANC_DEPT_KEYWORDS);
  const showPaedsHint = matchesAny(department, PAEDS_DEPT_KEYWORDS);
  const showErSection = matchesAny(department, ER_DEPT_KEYWORDS);
  const gaWeeks = useMemo(() => computeGaWeeks(lmpDate), [lmpDate]);
  const eddDate = useMemo(() => computeEdd(lmpDate), [lmpDate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Backend requires patient_phone OR patient_id — unless unidentified
    // mode is on AND department is EMERGENCY. The backend mints a
    // UNIDENT-* synthetic placeholder phone in that case so the
    // UNIQUE(phone) constraint stays honoured.
    if (!patientPhone && !(isUnidentified && showErSection)) {
      toast.error(
        showErSection
          ? "Mobile number required, or tick \"Unidentified patient\" for an unconscious arrival"
          : "Mobile number is required"
      );
      return;
    }
    // Guardian requirement: minor patients must have at least guardian
    // name + phone + relationship at intake — these flow through to the
    // legal-consent record and the dependent-profile model. Backend
    // would accept a partial payload, but the receptionist UI is the
    // last hard stop before the chart is opened.
    if (isMinor && (!guardianName || !guardianPhone || !guardianRelationship)) {
      toast.error("Minor patient — guardian name, phone, and relationship are required");
      return;
    }
    if (showAncSection && !lmpDate) {
      toast.error("LMP date is required for ANC walk-ins");
      return;
    }
    setSubmitting(true);
    try {
      const effectivePatientName =
        patientName || (isUnidentified && showErSection ? "Unidentified Patient" : "Walk-in Patient");
      const payload: WalkInPayload = {
        patient_phone: patientPhone || undefined,
        patient_name: effectivePatientName,
        patient_birthday: patientDob || undefined,
        patient_gender: patientGender || undefined,
        patient_address: patientAddress || undefined,
        patient_weight_kg: patientWeightKg ? Number(patientWeightKg) : undefined,
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
      if (isMinor) {
        payload.guardian_name = guardianName || undefined;
        payload.guardian_phone = guardianPhone || undefined;
        payload.guardian_relationship = guardianRelationship || undefined;
        payload.guardian_id_type = guardianIdType || undefined;
        payload.guardian_id_reference = guardianIdReference || undefined;
        const gid = parseInt(guardianUserId, 10);
        if (Number.isFinite(gid) && gid > 0) payload.guardian_user_id = gid;
      }
      if (showAncSection && lmpDate) {
        payload.lmp_date = lmpDate;
        if (eddDate) payload.edd_date = eddDate;
        if (gravida) payload.gravida = parseInt(gravida, 10);
        if (parity) payload.parity = parseInt(parity, 10);
        if (livingChildren) payload.living_children = parseInt(livingChildren, 10);
        if (abortions) payload.abortions = parseInt(abortions, 10);
      }
      if (showErSection && isUnidentified) {
        payload.mode = "unidentified";
        payload.unidentified = true;
        payload.visit_type = "EMERGENCY";
      }
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
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 max-h-[95vh] overflow-y-auto">
        <h3 className="text-lg font-bold mb-4">Register Walk-in Patient</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          {showErSection && (
            <label className="flex items-start gap-2 p-2 bg-amber-50 border border-amber-200 rounded">
              <input
                type="checkbox"
                checked={isUnidentified}
                onChange={e => setIsUnidentified(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm">
                <span className="font-medium">Unidentified patient</span>
                <span className="block text-xs text-gray-600">
                  Use for unconscious / no-ID arrivals. A temporary identifier
                  is generated; identity is merged when family arrives.
                </span>
              </span>
            </label>
          )}
          <div>
            <label className="text-sm font-medium">
              Patient Phone{isUnidentified && showErSection ? " (optional — unidentified)" : ""}
            </label>
            <input type="tel" value={patientPhone} onChange={e => setPatientPhone(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1"
              placeholder={isUnidentified && showErSection ? "Leave blank if unknown" : "10-digit mobile number"}
              disabled={isUnidentified && showErSection} />
          </div>
          <div>
            <label className="text-sm font-medium">Patient Name</label>
            <input type="text" value={patientName} onChange={e => setPatientName(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm mt-1"
              placeholder={isUnidentified && showErSection ? "Unidentified Patient" : "Full name"} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">
                DOB{showPaedsHint ? <span className="text-rose-600">*</span> : null}
              </label>
              <input type="date" value={patientDob} onChange={e => setPatientDob(e.target.value)}
                className="w-full border rounded px-3 py-2 text-sm mt-1" />
              {ageYears !== null && (
                <span className="text-xs text-gray-500 mt-1 block">
                  Age: {ageYears}y {isMinor ? "(minor — guardian required)" : ""}
                </span>
              )}
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
          {(showPaedsHint || isMinor) && (
            <div>
              <label className="text-sm font-medium">
                Weight (kg)
                <span className="text-xs text-gray-500 ml-1">— required for paediatric dosing</span>
              </label>
              <input type="number" step="0.01" min="0" max="999"
                value={patientWeightKg} onChange={e => setPatientWeightKg(e.target.value)}
                className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="e.g. 12.5" />
            </div>
          )}
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
          {isMinor && (
            <fieldset className="border border-amber-300 bg-amber-50 rounded p-3 space-y-2">
              <legend className="text-xs font-semibold text-amber-900 px-1">
                Guardian (required — minor patient)
              </legend>
              <div>
                <label className="text-xs font-medium">Guardian Name <span className="text-rose-600">*</span></label>
                <input type="text" value={guardianName} onChange={e => setGuardianName(e.target.value)}
                  className="w-full border rounded px-3 py-2 text-sm mt-1" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium">Phone <span className="text-rose-600">*</span></label>
                  <input type="tel" value={guardianPhone} onChange={e => setGuardianPhone(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm mt-1" />
                </div>
                <div>
                  <label className="text-xs font-medium">Relationship <span className="text-rose-600">*</span></label>
                  <select value={guardianRelationship} onChange={e => setGuardianRelationship(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm mt-1 bg-white">
                    <option value="">— Select —</option>
                    <option value="mother">Mother</option>
                    <option value="father">Father</option>
                    <option value="grandparent">Grandparent</option>
                    <option value="legal_guardian">Legal guardian</option>
                    <option value="sibling">Sibling</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium">ID Type</label>
                  <select value={guardianIdType} onChange={e => setGuardianIdType(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm mt-1 bg-white">
                    <option value="">— Select —</option>
                    <option value="aadhaar">Aadhaar</option>
                    <option value="pan">PAN</option>
                    <option value="voter_id">Voter ID</option>
                    <option value="passport">Passport</option>
                    <option value="driving_licence">Driving licence</option>
                    <option value="ration_card">Ration card</option>
                    <option value="abha">ABHA</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium">
                    ID Reference
                    <span className="text-gray-500 ml-1 text-[10px]">last 4 digits</span>
                  </label>
                  <input type="text" value={guardianIdReference} onChange={e => setGuardianIdReference(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm mt-1" placeholder="e.g. XXXX-XXXX-4821" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium">
                  Existing Guardian User ID
                  <span className="text-gray-500 ml-1 text-[10px]">if guardian already has an account</span>
                </label>
                <input type="number" min="1" value={guardianUserId} onChange={e => setGuardianUserId(e.target.value)}
                  className="w-full border rounded px-3 py-2 text-sm mt-1"
                  placeholder="links minor's profile to guardian as dependent" />
              </div>
            </fieldset>
          )}
          {showAncSection && (
            <fieldset className="border border-pink-300 bg-pink-50 rounded p-3 space-y-2">
              <legend className="text-xs font-semibold text-pink-900 px-1">
                ANC / Obstetric (required)
              </legend>
              <div>
                <label className="text-xs font-medium">
                  LMP date <span className="text-rose-600">*</span>
                  {gaWeeks !== null && (
                    <span className="text-xs text-gray-600 ml-2">≈ {gaWeeks} weeks GA</span>
                  )}
                </label>
                <input type="date" value={lmpDate} onChange={e => setLmpDate(e.target.value)}
                  className="w-full border rounded px-3 py-2 text-sm mt-1" />
                {eddDate && (
                  <span className="text-xs text-gray-600 mt-1 block">EDD: {eddDate}</span>
                )}
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div>
                  <label className="text-xs font-medium">G</label>
                  <input type="number" min="0" max="20" value={gravida} onChange={e => setGravida(e.target.value)}
                    className="w-full border rounded px-2 py-2 text-sm mt-1" placeholder="1" />
                </div>
                <div>
                  <label className="text-xs font-medium">P</label>
                  <input type="number" min="0" max="20" value={parity} onChange={e => setParity(e.target.value)}
                    className="w-full border rounded px-2 py-2 text-sm mt-1" placeholder="0" />
                </div>
                <div>
                  <label className="text-xs font-medium">L</label>
                  <input type="number" min="0" max="20" value={livingChildren}
                    onChange={e => setLivingChildren(e.target.value)}
                    className="w-full border rounded px-2 py-2 text-sm mt-1" placeholder="0" />
                </div>
                <div>
                  <label className="text-xs font-medium">A</label>
                  <input type="number" min="0" max="20" value={abortions}
                    onChange={e => setAbortions(e.target.value)}
                    className="w-full border rounded px-2 py-2 text-sm mt-1" placeholder="0" />
                </div>
              </div>
            </fieldset>
          )}
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
