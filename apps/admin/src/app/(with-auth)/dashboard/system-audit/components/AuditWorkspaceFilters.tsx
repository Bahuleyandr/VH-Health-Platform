"use client";

import type { FormEvent } from "react";
import { RotateCcw, Search } from "lucide-react";
import type {
  AuditWorkspaceFilters,
  AuditWorkspaceView,
} from "../auditTypes";

interface AuditWorkspaceFiltersProps {
  view: AuditWorkspaceView;
  filters: AuditWorkspaceFilters;
  displayTimezone: string;
  onTimezoneChange: (timezone: string) => void;
  onChange: (field: keyof AuditWorkspaceFilters, value: string) => void;
  onSubmit: () => void;
  onReset: () => void;
}

const inputClass =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100";

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
      {children}
    </span>
  );
}

export function AuditWorkspaceFiltersPanel({
  view,
  filters,
  displayTimezone,
  onTimezoneChange,
  onChange,
  onSubmit,
  onReset,
}: AuditWorkspaceFiltersProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form
      aria-label="Audit workspace filters"
      onSubmit={submit}
      className="rounded-lg border border-gray-200 bg-card p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {view === "doctor"
              ? "Doctor activity filters"
              : view === "staff"
                ? "Staff activity filters"
                : view === "patient"
                  ? "Patient audit filters"
                  : view === "time"
                    ? "Date and time explorer"
                    : "Audit event filters"}
          </h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Times are sent as ISO 8601 instants. Every result remains tenant-scoped.
          </p>
        </div>
        <label className="min-w-[190px]">
          <FieldLabel>Display timezone</FieldLabel>
          <select
            aria-label="Display timezone"
            className={inputClass}
            value={displayTimezone}
            onChange={(event) => onTimezoneChange(event.target.value)}
          >
            <option value="Asia/Kolkata">Hospital time (IST)</option>
            <option value="UTC">UTC</option>
          </select>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label>
          <FieldLabel>Staff UID</FieldLabel>
          <input
            aria-label="Filter by staff UID"
            className={inputClass}
            placeholder="Doctor or staff UID"
            value={filters.actor_uid}
            onChange={(event) => onChange("actor_uid", event.target.value)}
          />
        </label>

        <label>
          <FieldLabel>Staff role</FieldLabel>
          <select
            aria-label="Filter by staff role"
            className={inputClass}
            value={filters.actor_role}
            onChange={(event) => onChange("actor_role", event.target.value)}
          >
            <option value="">All staff roles</option>
            <option value="STAFF_GROUP">All clinical and operational staff</option>
            <option value="DOCTOR_GROUP">All doctor roles</option>
            <option value="DOCTOR">Doctor</option>
            <option value="NURSE">Nurse</option>
            <option value="LAB_TECHNICIAN">Lab technician</option>
            <option value="RADIOLOGIST">Radiologist</option>
            <option value="PHARMACIST">Pharmacist</option>
            <option value="RECEPTIONIST">Receptionist</option>
            <option value="ADMIN">Admin</option>
            <option value="SUPER_ADMIN">Super admin</option>
          </select>
        </label>

        <label>
          <FieldLabel>Patient UID</FieldLabel>
          <input
            aria-label="Filter by patient UID"
            className={inputClass}
            placeholder="Patient UID or UHID"
            value={filters.patient_uid}
            onChange={(event) => onChange("patient_uid", event.target.value)}
          />
        </label>

        <label>
          <FieldLabel>Department ID</FieldLabel>
          <input
            aria-label="Filter by department ID"
            className={inputClass}
            placeholder="Department ID"
            value={filters.department_id}
            onChange={(event) => onChange("department_id", event.target.value)}
          />
        </label>

        <label>
          <FieldLabel>Action</FieldLabel>
          <input
            aria-label="Filter by action"
            className={inputClass}
            placeholder="e.g. note.signed"
            value={filters.action}
            onChange={(event) => onChange("action", event.target.value)}
          />
        </label>

        <label>
          <FieldLabel>Resource type</FieldLabel>
          <input
            aria-label="Filter by resource type"
            className={inputClass}
            placeholder="Note, order, investigation…"
            value={filters.resource_type}
            onChange={(event) => onChange("resource_type", event.target.value)}
          />
        </label>

        <label>
          <FieldLabel>Outcome</FieldLabel>
          <select
            aria-label="Filter by outcome"
            className={inputClass}
            value={filters.outcome}
            onChange={(event) => onChange("outcome", event.target.value)}
          >
            <option value="">All outcomes</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
            <option value="denied">Denied</option>
            <option value="break_glass">Break glass</option>
          </select>
        </label>

        <label>
          <FieldLabel>Source</FieldLabel>
          <select
            aria-label="Filter by source"
            className={inputClass}
            value={filters.source}
            onChange={(event) => onChange("source", event.target.value)}
          >
            <option value="">All audit sources</option>
            <option value="clinical">Clinical actions</option>
            <option value="request">HTTP requests</option>
            <option value="patient_access">Patient access</option>
            <option value="phi_access">PHI access</option>
            <option value="operational">Operational actions</option>
          </select>
        </label>

        <label>
          <FieldLabel>Encounter ID</FieldLabel>
          <input
            aria-label="Filter by encounter ID"
            className={inputClass}
            placeholder="Encounter ID"
            value={filters.encounter_id}
            onChange={(event) => onChange("encounter_id", event.target.value)}
          />
        </label>

        <label>
          <FieldLabel>Admission ID</FieldLabel>
          <input
            aria-label="Filter by admission ID"
            className={inputClass}
            placeholder="Admission ID"
            value={filters.admission_id}
            onChange={(event) => onChange("admission_id", event.target.value)}
          />
        </label>

        <label>
          <FieldLabel>From date and time</FieldLabel>
          <input
            type="datetime-local"
            aria-label="Events from date and time"
            className={inputClass}
            value={filters.from}
            onChange={(event) => onChange("from", event.target.value)}
          />
        </label>

        <label>
          <FieldLabel>To date and time</FieldLabel>
          <input
            type="datetime-local"
            aria-label="Events to date and time"
            className={inputClass}
            value={filters.to}
            onChange={(event) => onChange("to", event.target.value)}
          />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <RotateCcw className="h-4 w-4" />
          Clear filters
        </button>
        <button
          type="submit"
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Search className="h-4 w-4" />
          Apply filters
        </button>
      </div>
    </form>
  );
}
