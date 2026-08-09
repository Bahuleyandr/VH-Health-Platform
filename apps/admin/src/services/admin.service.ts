// src/services/admin.service.ts
import { API_ENDPOINTS, buildProxyUrl } from "@/lib/api-config";

class AdminService {
  // Token is no longer read from localStorage (XSS risk).
  // All requests go through /api/proxy which uses the httpOnly cookie.
  // This method is kept for backward compatibility with getHeaders() calls
  // but always returns undefined — the proxy injects the real token server-side.
  private getToken(): string | undefined {
    return undefined;
  }

  private buildQuery(path: string, params?: Record<string, unknown>): string {
    if (!params) return path;
    const usp = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== "") usp.set(k, String(v));
    });
    const qs = usp.toString();
    return qs ? `${path}?${qs}` : path;
  }

  private async request(path: string, init?: RequestInit) {
    // Route through /api/proxy which uses the httpOnly cookie for auth
    // and injects the API key server-side.
    const proxyPath = buildProxyUrl(path);

    const res = await fetch(proxyPath, {
      ...init,
      credentials: "include", // send httpOnly cookie
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        "Content-Type":
          (init?.headers as Record<string, string> | undefined)?.["Content-Type"] ??
          "application/json",
      },
    });
    return this.handleResponse(res);
  }

  private async handleResponse(response: Response) {
    const contentType = response.headers.get("content-type") ?? "";
    const isJson = contentType.includes("application/json");

    if (!response.ok) {
      let message = `API request failed (${response.status})`;
      try {
        if (isJson) {
          const err = await response.json();
          message = (err?.message as string) ?? message;
        } else {
          const text = await response.text();
          if (text) message = text;
        }
      } catch {
        // ignore parse errors, use default message
      }
      throw new Error(message);
    }

    return isJson ? response.json() : response.text();
  }

  /* ------------------------------ Core Admin ------------------------------ */

  async getDashboard() {
    return this.request(API_ENDPOINTS.admin.dashboard);
  }

  async getQuickStats() {
    // quick lives under admin.stats.quick
    return this.request(API_ENDPOINTS.admin.stats.quick);
  }

  async getRecentActivity(limit = 50, offset = 0) {
    // recent activity lives under admin.activity.recent
    const path = this.buildQuery(API_ENDPOINTS.admin.activity.recent, {
      limit,
      offset,
    });
    return this.request(path);
  }

  async getSystemAlerts() {
    // system alerts lives under admin.alerts.system
    return this.request(API_ENDPOINTS.admin.alerts.system);
  }

  async getModuleHealth() {
    // module health lives under admin.health.modules
    return this.request(API_ENDPOINTS.admin.health.modules);
  }

  async getStaffSummary() {
    // staff summary under admin.stats.staff
    return this.request(API_ENDPOINTS.admin.stats.staff);
  }

  async getAppointmentsSummary() {
    // appointment summary under admin.stats.appointmentSummary
    return this.request(API_ENDPOINTS.admin.stats.appointmentSummary);
  }

  async refreshDashboardCache() {
  return this.request(API_ENDPOINTS.admin.reports.refreshCache, { method: "POST" });
}

  // If you truly have an "export dashboard" route in records, point there.
  // (Earlier mapping showed no admin.exportReport key.)
  async exportDashboardReport(
  body: { format?: "pdf" | "xlsx"; dateRange?: unknown } = {},
) {
  return this.request(API_ENDPOINTS.admin.reports.generate, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

  /* -------------------------- Staff Attendance (NEW) -------------------------- */

  async getAttendanceAnalytics(
    q: {
      department?: string | null;
      start_date?: string | null;
      end_date?: string | null;
      group_by?: "day" | "week" | "month";
    } = {},
  ) {
    const path = this.buildQuery(API_ENDPOINTS.admin.attendance.analytics, q);
    return this.request(path);
  }

  async getAttendanceAnomalies() {
    return this.request(API_ENDPOINTS.admin.attendance.anomalies);
  }

  async getLateArrivals(q: { date?: string; department?: string | null } = {}) {
    const path = this.buildQuery(
      API_ENDPOINTS.admin.attendance.lateArrivals,
      q,
    );
    return this.request(path);
  }

  async getEarlyDepartures(
    q: { date?: string; department?: string | null } = {},
  ) {
    const path = this.buildQuery(
      API_ENDPOINTS.admin.attendance.earlyDepartures,
      q,
    );
    return this.request(path);
  }

  async getAbsentReport(q: { date?: string; department?: string | null } = {}) {
    const path = this.buildQuery(
      API_ENDPOINTS.admin.attendance.absentReport,
      q,
    );
    return this.request(path);
  }

  /* ------------------------------ SOS (NEW) ------------------------------ */

  async getSosAnalytics() {
    return this.request(API_ENDPOINTS.admin.sos.analytics);
  }

  async listSosAlerts(p: { limit?: number; offset?: number } = {}) {
    const path = this.buildQuery(API_ENDPOINTS.admin.sos.alerts, p);
    return this.request(path);
  }

  async getEmergencyServices() {
    // renamed to emergencyServices
    return this.request(API_ENDPOINTS.admin.sos.emergencyServices);
  }

  async getSosPerformanceReport() {
    return this.request(API_ENDPOINTS.admin.sos.performanceReport);
  }

  async broadcastSosAlert(body: {
    message: string;
    severity?: "HIGH" | "MEDIUM" | "LOW";
  }) {
    return this.request(API_ENDPOINTS.admin.sos.broadcast, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async escalateSosAlert(alertId: string, body?: { reason?: string }) {
    const path = API_ENDPOINTS.admin.sos.escalate(alertId);
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  /* ----------------------- Uploads / File Management (NEW) ----------------------- */

  async getUploadSummary() {
    return this.request(API_ENDPOINTS.admin.uploads.summary);
  }

  async listQuarantinedFiles(p: { limit?: number; offset?: number } = {}) {
    // quarantined list key name
    const path = this.buildQuery(API_ENDPOINTS.admin.uploads.quarantined, p);
    return this.request(path);
  }

  async getHipaaAuditReport(
    p: {
      limit?: number;
      offset?: number;
      start_date?: string | null;
      end_date?: string | null;
    } = {},
  ) {
    const path = this.buildQuery(API_ENDPOINTS.admin.uploads.hipaaAudit, p);
    return this.request(path);
  }

  async rescanFile(fileId: string) {
    const path = API_ENDPOINTS.admin.uploads.rescan.replace(":fileId", encodeURIComponent(fileId));
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  }

  async cleanupExpiredFiles(dryRun = true) {
    return this.request(API_ENDPOINTS.admin.uploads.cleanup, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun }),
    });
  }

  async bulkUpdateHipaaProtection(payload: {
    ids: string[];
    protect: boolean;
  }) {
    // key renamed to bulkHipaa
    return this.request(API_ENDPOINTS.admin.uploads.bulkHipaa, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async purgeQuarantinedFiles(dryRun = true) {
    return this.request(API_ENDPOINTS.admin.uploads.purgeQuarantine, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun }),
    });
  }
}

export const adminService = new AdminService();
