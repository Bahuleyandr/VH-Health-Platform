// src/services/admin.service.ts
import { API_ENDPOINTS, API_BASE_URL, getHeaders } from '@/lib/api-config';

class AdminService {
  private getToken(): string | null {
    return localStorage.getItem('adminToken');
  }

  async getDashboard() {
    const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.admin.dashboard}`, {
      headers: getHeaders(this.getToken()),
    });
    return this.handleResponse(response);
  }

  async getQuickStats() {
    const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.admin.quickStats}`, {
      headers: getHeaders(this.getToken()),
    });
    return this.handleResponse(response);
  }

  async getRecentActivity(limit = 50, offset = 0) {
    const url = `${API_BASE_URL}${API_ENDPOINTS.admin.recentActivity}?limit=${limit}&offset=${offset}`;
    const response = await fetch(url, {
      headers: getHeaders(this.getToken()),
    });
    return this.handleResponse(response);
  }

  async getSystemAlerts() {
    const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.admin.alerts}`, {
      headers: getHeaders(this.getToken()),
    });
    return this.handleResponse(response);
  }

  async getStaffSummary() {
    const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.admin.staffSummary}`, {
      headers: getHeaders(this.getToken()),
    });
    return this.handleResponse(response);
  }

  async getAppointmentsSummary() {
    const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.admin.appointmentsSummary}`, {
      headers: getHeaders(this.getToken()),
    });
    return this.handleResponse(response);
  }

  private async handleResponse(response: Response) {
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'API request failed');
    }
    return response.json();
  }
}

export const adminService = new AdminService();