import { fetchAdminAPI } from "./core";

export type MisReportCadence = "daily" | "weekly" | "monthly";
export type MisRunStatus = "running" | "sent" | "partial" | "failed";
export type MisDeliveryOutcome = "acknowledged" | "rejected" | "uncertain";

export interface MisReportCatalogEntry {
  key: string;
  title: string;
}

export interface MisReportScheduleRunRecipient {
  email: string;
  outcome: MisDeliveryOutcome;
  failureCode?: string | null;
}

export interface MisReportScheduleRunDetail {
  occurrence?: string;
  trigger?: "scheduled" | "manual";
  reports?: string[];
  recipients?: MisReportScheduleRunRecipient[];
  failureCode?: string;
  error?: string;
}

export interface MisReportSchedule {
  id: number;
  name: string;
  reportKeys: string[];
  cadence: MisReportCadence;
  sendHour: number;
  sendWeekday: number | null;
  sendDayOfMonth: number | null;
  recipients: string[];
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: MisRunStatus | null;
  lastRunDetail: MisReportScheduleRunDetail | null;
  lastOccurrenceKey: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MisReportScheduleList {
  schedules: MisReportSchedule[];
  reports: MisReportCatalogEntry[];
  count: number;
}

export interface MisReportScheduleWrite {
  name?: string;
  reportKeys?: string[];
  cadence?: MisReportCadence;
  sendHour?: number;
  sendWeekday?: number | null;
  sendDayOfMonth?: number | null;
  recipients?: string[];
  enabled?: boolean;
}

export interface MisReportScheduleRunResult {
  scheduleId: number;
  status: "sent" | "partial" | "failed";
  occurrenceKey: string;
  deliveries: MisReportScheduleRunRecipient[];
}

export async function listMisReportSchedules() {
  return fetchAdminAPI<MisReportScheduleList>(
    "/dashboards/mis-report-schedules",
  );
}

export async function createMisReportSchedule(payload: MisReportScheduleWrite) {
  return fetchAdminAPI<MisReportSchedule>("/dashboards/mis-report-schedules", {
    method: "POST",
    body: payload,
  });
}

export async function updateMisReportSchedule(
  id: number,
  payload: MisReportScheduleWrite,
) {
  return fetchAdminAPI<MisReportSchedule>(
    `/dashboards/mis-report-schedules/${id}`,
    {
      method: "PATCH",
      body: payload,
    },
  );
}

export async function deleteMisReportSchedule(id: number) {
  return fetchAdminAPI<{ deleted: boolean; id: number }>(
    `/dashboards/mis-report-schedules/${id}`,
    { method: "DELETE" },
  );
}

export async function runMisReportScheduleNow(id: number) {
  return fetchAdminAPI<MisReportScheduleRunResult>(
    `/dashboards/mis-report-schedules/${id}/run-now`,
    { method: "POST" },
  );
}
