// controllers/investigation/reportController.js
import db from '../../config/database.js'; // <-- ADD THIS LINE
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as investigationService from '../../services/investigation/investigationService.js';
import * as reportService from '../../services/investigation/reportService.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error } from '../../utils/responseHelper.js';

// Generate investigation report PDF
export const generateReport = async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role?.toUpperCase();
    const requestedBy = req.user?.uid;
    
    // Check if user has access to this investigation
    const investigation = await investigationService.getInvestigationById(
      id,
      userRole,
      requestedBy
    );
    
    if (!investigation) {
      return error(res, 'Investigation not found or access denied', 404);
    }

    // Only generate report for completed investigations
    if (investigation.status !== 'COMPLETED') {
      return error(res, 'Reports can only be generated for completed investigations', 400);
    }
    
    const pdfBuffer = await reportService.generateInvestigationReport(id);
    
    await logAudit(req, 'investigation-report-generated', { 
      investigation_id: id,
      patient_id: investigation.patient_id 
    });
    
    // Set response headers for PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition', 
      `attachment; filename="investigation_report_${id}_${Date.now()}.pdf"`
    );
    res.setHeader('Content-Length', pdfBuffer.length);
    
    // Send PDF buffer
    res.send(pdfBuffer);
    
  } catch (err) {
    logger.error('Generate Report Error:', err);
    error(res, 'Failed to generate report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Generate summary report for multiple investigations
export const generateSummaryReport = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const requestedBy = req.user?.uid;
    const { patient_id, date_from, date_to, type } = req.query;
    
    // Validate permissions
    if (userRole === 'PATIENT') {
      // Patients can only generate their own summary reports
      const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [requestedBy]);
      if (!userResult.rows.length || userResult.rows[0].id !== parseInt(patient_id)) {
        return error(res, 'Access denied: Cannot generate reports for other patients', 403);
      }
    }

    if (!patient_id) {
      return error(res, 'Patient ID is required', 400);
    }
    
    const summaryData = await reportService.generatePatientSummaryReport({
      patient_id,
      date_from,
      date_to,
      type
    });
    
    await logAudit(req, 'investigation-summary-report-generated', { 
      patient_id,
      date_range: { from: date_from, to: date_to },
      type
    });
    
    // Set response headers for PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition', 
      `attachment; filename="investigation_summary_${patient_id}_${Date.now()}.pdf"`
    );
    res.setHeader('Content-Length', summaryData.length);
    
    res.send(summaryData);
    
  } catch (err) {
    logger.error('Generate Summary Report Error:', err);
    error(res, 'Failed to generate summary report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Export investigations to Excel
export const exportToExcel = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const requestedBy = req.user?.uid;
    
    // Only staff can export to Excel
    const allowedRoles = ['DOCTOR', 'NURSE', 'LAB_TECHNICIAN', 'RADIOLOGIST', 'ADMIN'];
    if (!allowedRoles.includes(userRole)) {
      return error(res, 'Access denied: Staff privileges required', 403);
    }
    
    const { 
      date_from, 
      date_to, 
      type, 
      status, 
      department_id 
    } = req.query;
    
    const excelBuffer = await reportService.exportInvestigationsToExcel({
      date_from,
      date_to,
      type,
      status,
      department_id
    });
    
    await logAudit(req, 'investigations-exported-excel', { 
      filters: { date_from, date_to, type, status, department_id }
    });
    
    // Set response headers for Excel
    res.setHeader(
      'Content-Type', 
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition', 
      `attachment; filename="investigations_export_${Date.now()}.xlsx"`
    );
    res.setHeader('Content-Length', excelBuffer.length);
    
    res.send(excelBuffer);
    
  } catch (err) {
    logger.error('Export to Excel Error:', err);
    error(res, 'Failed to export investigations', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Generate statistics report
export const generateStatisticsReport = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const requestedBy = req.user?.uid;
    
    // Only management can generate statistics reports
    if (!['ADMIN', 'DOCTOR'].includes(userRole)) {
      return error(res, 'Access denied: Management privileges required', 403);
    }
    
    const { period = 'monthly', year = new Date().getFullYear() } = req.query;
    
    const statsReport = await reportService.generateStatisticsReport({
      period,
      year: parseInt(year)
    });
    
    await logAudit(req, 'investigation-statistics-report-generated', { 
      period,
      year
    });
    
    success(res, {
      report: statsReport,
      generatedBy: requestedBy
    }, 'Statistics report generated successfully');
    
  } catch (err) {
    logger.error('Generate Statistics Report Error:', err);
    error(res, 'Failed to generate statistics report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Email investigation report
export const emailReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { email, cc, message } = req.body;
    const userRole = req.user?.role?.toUpperCase();
    const sentBy = req.user?.uid;
    
    // Check permissions
    const allowedRoles = ['DOCTOR', 'LAB_TECHNICIAN', 'RADIOLOGIST', 'ADMIN'];
    if (!allowedRoles.includes(userRole)) {
      return error(res, 'Access denied: Medical staff privileges required', 403);
    }

    if (!email) {
      return error(res, 'Email address is required', 400);
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return error(res, 'Invalid email format', 400);
    }
    
    const result = await reportService.emailInvestigationReport(
      id,
      { email, cc, message },
      sentBy
    );
    
    await logAudit(req, 'investigation-report-emailed', { 
      investigation_id: id,
      sent_to: email,
      cc
    });
    
    success(res, {
      message: 'Report sent successfully',
      sent_to: email,
      sentBy,
      result: result
    }, 'Report emailed successfully');
    
  } catch (err) {
    logger.error('Email Report Error:', err);
    
    if (err.message === 'Investigation not found') {
      return error(res, err.message, 404);
    }
    
    error(res, 'Failed to email report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};