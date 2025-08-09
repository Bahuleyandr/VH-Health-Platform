// src/services/admin.service.ts
import { API_ENDPOINTS, API_BASE_URL, getHeaders } from '@/lib/api-config';

class AdminService {
  // Return undefined (not null), and be safe on the server.
  private getToken(): string | undefined {
    if (typeof window === 'undefined') return undefined;
    return localStorage.getItem('adminToken') ?? undefined;
  }

  private async request(path: string, init?: RequestInit) {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        // allow caller to pass extra headers if needed
        ...(init?.headers as Record<string, string> | undefined),
        // merge in our auth and default headers
        ...getHeaders(this.getToken()),
      },
    });
    return this.handleResponse(res);
  }

  async getDashboard() {
    return this.request(API_ENDPOINTS.admin.dashboard);
  }

  async getQuickStats() {
    return this.request(API_ENDPOINTS.admin.quickStats);
  }

  async getRecentActivity(limit = 50, offset = 0) {
    const path = `${API_ENDPOINTS.admin.recentActivity}?limit=${limit}&offset=${offset}`;
    return this.request(path);
  }

  async getSystemAlerts() {
    return this.request(API_ENDPOINTS.admin.alerts);
  }

  async getStaffSummary() {
    return this.request(API_ENDPOINTS.admin.staffSummary);
  }

  async getAppointmentsSummary() {
    return this.request(API_ENDPOINTS.admin.appointmentsSummary);
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
}

export const adminService = new AdminService();
