// src/lib/api/staff.ts
import { getJSON, postJSON } from "./core";

export interface ShiftAssignment {
  staffId: number;
  shift: string;
  dates: string[];
}

export function getStaffByShift<T = unknown>(shift: string) {
  return getJSON<T>(`/staff/shift/${shift}`);
}

export function bulkShiftAssignment<T = unknown>(
  assignments: ShiftAssignment[]
) {
  return postJSON<T>("/admin/staff/bulk/shift-assignment", { assignments });
}
