// src/services/admin.service.ts
import { API_ENDPOINTS, API_BASE_URL, getHeaders } from '@/lib/api-config';

class AdminService {
  // Return undefined (not null), and be safe on the server.
  private getToken(): string | undefined {
    if (typeof window === 'undefined') return undefined;
    return localStorage.getItem('adminToken') ?? undefined;
  }

  private buildQuery(path: string, params?: Record<string, unknown>): string {
    if (!params) return path;
    const usp = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== '') usp.set(k, String(v));
    });
    const qs = usp.toString();
    return qs ? `${path}?${qs}` : path;
  }

  private async request(path: string, init?: RequestInit) {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        ...getHeaders(this.getToken()),
      },
    });
    return this.handleResponse(res);
  }

  private async handleResponse(response: Response) {
    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');

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
    return this.request(API_ENDPOINTS.admin.quickStats);
  }

  async getRecentActivity(limit = 50, offset = 0) {
    const path = this.buildQuery(API_ENDPOINTS.admin.recentActivity, { limit, offset });
    return this.request(path);
  }

  async getSystemAlerts() {
    return this.request(API_ENDPOINTS.admin.alerts);
  }

  async getModuleHealth() {
    return this.request(API_ENDPOINTS.admin.moduleHealth);
  }

  async getStaffSummary() {
    return this.request(API_ENDPOINTS.admin.staffSummary);
  }

  async getAppointmentsSummary() {
    return this.request(API_ENDPOINTS.admin.appointmentsSummary);
  }

  async refreshDashboardCache() {
    return this.request(API_ENDPOINTS.admin.refreshCache, { method: 'POST' });
  }

  async exportDashboardReport(body: { format?: 'pdf' | 'xlsx'; dateRange?: unknown } = {}) {
    return this.request(API_ENDPOINTS.admin.exportReport, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /* -------------------------- Staff Attendance (NEW) -------------------------- */

  async getAttendanceAnalytics(q: {
    department?: string | null;
    start_date?: string | null;
    end_date?: string | null;
    group_by?: 'day' | 'week' | 'month';
  } = {}) {
    const path = this.buildQuery(API_ENDPOINTS.admin.attendance.analytics, q);
    return this.request(path);
  }

  async getAttendanceAnomalies() {
    return this.request(API_ENDPOINTS.admin.attendance.anomalies);
  }

  async getLateArrivals(q: { date?: string; department?: string | null } = {}) {
    const path = this.buildQuery(API_ENDPOINTS.admin.attendance.lateArrivals, q);
    return this.request(path);
  }

  async getEarlyDepartures(q: { date?: string; department?: string | null } = {}) {
    const path = this.buildQuery(API_ENDPOINTS.admin.attendance.earlyDepartures, q);
    return this.request(path);
  }

  async getAbsentReport(q: { date?: string; department?: string | null } = {}) {
    const path = this.buildQuery(API_ENDPOINTS.admin.attendance.absentReport, q);
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
    return this.request(API_ENDPOINTS.admin.sos.services);
  }

  async getSosPerformanceReport() {
    return this.request(API_ENDPOINTS.admin.sos.performanceReport);
  }

  async updateSosConfig(body: unknown) {
    return this.request(API_ENDPOINTS.admin.sos.updateConfig, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  async broadcastSosAlert(body: { message: string; severity?: 'HIGH' | 'MEDIUM' | 'LOW' }) {
    return this.request(API_ENDPOINTS.admin.sos.broadcast, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async escalateSosAlert(alertId: string, body?: { reason?: string }) {
    const path = API_ENDPOINTS.admin.sos.escalate(alertId);
    return this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  /* ----------------------- Uploads / File Management (NEW) ----------------------- */

  async getUploadSummary() {
    return this.request(API_ENDPOINTS.admin.uploads.summary);
  }

  async listQuarantinedFiles(p: { limit?: number; offset?: number } = {}) {
    const path = this.buildQuery(API_ENDPOINTS.admin.uploads.quarantine, p);
    return this.request(path);
  }

  async getHipaaAuditReport(p: {
    limit?: number;
    offset?: number;
    start_date?: string | null;
    end_date?: string | null;
  } = {}) {
    const path = this.buildQuery(API_ENDPOINTS.admin.uploads.hipaaAudit, p);
    return this.request(path);
  }

  async rescanFile(fileId: string) {
    return this.request(API_ENDPOINTS.admin.uploads.rescan(fileId), { method: 'POST' });
  }

  async cleanupExpiredFiles(dryRun = true) {
    return this.request(API_ENDPOINTS.admin.uploads.cleanup, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun }),
    });
  }

  async bulkUpdateHipaaProtection(payload: { ids: string[]; protect: boolean }) {
    return this.request(API_ENDPOINTS.admin.uploads.hipaaBulkProtect, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async purgeQuarantinedFiles(dryRun = true) {
    return this.request(API_ENDPOINTS.admin.uploads.purgeQuarantine, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun }),
    });
  }
}

export const adminService = new AdminService();
