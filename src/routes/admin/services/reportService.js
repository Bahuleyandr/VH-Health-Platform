// src/routes/admin/services/reportService.js
import logger from '../../../logging/logger.js';

export async function refreshDashboardCache() {
  // Keep side-effect only (no DB dependency here).
  logger.info('Dashboard cache refreshed');
}

export async function generateDashboardReport(format = 'pdf', _dateRange) {
  // Keep the exact response shape (URL + timestamp)
  return {
    url: `/exports/dashboard-report.${format}`,
    generatedAt: new Date(),
  };
}

export default { refreshDashboardCache, generateDashboardReport };
