"use client";

import type { Appointment } from "@/lib/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AppointmentRow = Appointment & {
  patient_name?: string;
  doctor_name?: string;
  department?: string;
};

export type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

export type AppointmentsAPIResponse = {
  appointments: AppointmentRow[];
  pagination: Pagination;
};

export interface EPrescription {
  id: number;
  prescription_number: string;
  appointment_id: number | null;
  patient_id: number;
  doctor_id: number;
  diagnosis: string;
  medications: Array<{
    name: string;
    generic_name?: string;
    catalog_id?: number;
    dosage: string;
    frequency: string;
    duration: string;
    route: string;
    instructions?: string;
    quantity?: number;
  }>;
  vitals?: Record<string, number>;
  follow_up_date?: string;
  follow_up_notes?: string;
  clinical_notes?: string;
  pdf_key?: string;
  pdf_url?: string;
  pharmacy_opted: boolean;
  pharmacy_order_id?: number;
  pharmacy_opt_type?: string;
  status: string;
  created_at: string;
  patient_name?: string;
  patient_phone?: string;
  doctor_name?: string;
  doctor_specialization?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export function normalizeAppointmentsResponse(
  response: unknown,
  page: number,
  requestedLimit = 10,
): AppointmentsAPIResponse {
  if (Array.isArray(response)) {
    const list = response as AppointmentRow[];
    return {
      appointments: list,
      pagination: {
        page,
        limit: requestedLimit,
        total: list.length,
        totalPages: Math.max(1, Math.ceil(list.length / requestedLimit)),
        hasNext: false,
        hasPrev: page > 1,
      },
    };
  }
  if (isObj(response)) {
    const appts =
      ((Array.isArray((response as Record<string, unknown>)["appointments"])
        ? (response as Record<string, unknown>)["appointments"]
        : (response as Record<string, unknown>)["data"]) as AppointmentRow[]) ??
      [];
    const total =
      typeof (response as Record<string, unknown>)["total"] === "number"
        ? ((response as Record<string, unknown>)["total"] as number)
        : appts.length;
    const limit =
      typeof (response as Record<string, unknown>)["limit"] === "number"
        ? ((response as Record<string, unknown>)["limit"] as number)
        : requestedLimit;
    return {
      appointments: appts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }
  return {
    appointments: [],
    pagination: {
      page,
      limit: requestedLimit,
      total: 0,
      totalPages: 1,
      hasNext: false,
      hasPrev: page > 1,
    },
  };
}

export function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function fmtDateTime(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Status badge ──────────────────────────────────────────────────────────────

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    SCHEDULED: "bg-orange-100 text-orange-700",
    CONFIRMED: "bg-teal-100 text-teal-700",
    COMPLETED: "bg-green-100 text-green-700",
    CANCELLED: "bg-red-100 text-red-700",
    NO_SHOW: "bg-gray-100 text-gray-600",
  };
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${map[status] ?? "bg-blue-100 text-blue-700"}`}
    >
      {status}
    </span>
  );
}
