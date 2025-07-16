// src/controllers/doctor/doctorStatsController.js
import { validationResult } from 'express-validator';
import { DOCTOR_CONFIG } from '../../config/doctorConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { doctorStatsService } from '../../services/doctor/doctorStatsService.js';
import { success, error } from '../../utils/responseHelper.js';

export const doctorStatsController = {
  // Get doctor statistics
  getDoctorStats: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, errors.array()[0].msg, HTTP_STATUS.BAD_REQUEST);
      }
      
      const { id } = req.params;
      const months = parseInt(req.query.months) || 6;
      
      // Role-based access control
      if (req.user?.role === 'DOCTOR' && req.user.id !== parseInt(id)) {
        return error(res, 'Can only view your own statistics', HTTP_STATUS.FORBIDDEN);
      }
      
      const stats = await doctorStatsService.getDoctorStats(id, months);
      
      success(res, {
        doctor_id: id,
        statistics: {
          appointments_last_n_months: stats.appointments,
          patient_statistics: stats.patients,
          revenue_last_n_months: stats.revenue
        },
        period: `Last ${months} months`,
        requestedBy: req.user?.name
      }, 'Doctor statistics retrieved successfully');
    } catch (err) {
      logger.error('Error fetching doctor stats:', err);
      
      // Return empty stats as fallback
      success(res, {
        doctor_id: req.params.id,
        statistics: {
          appointments_last_n_months: {
            total_appointments: 0,
            completed_appointments: 0,
            scheduled_appointments: 0,
            cancelled_appointments: 0
          },
          patient_statistics: {
            unique_patients: 0,
            total_consultations: 0
          },
          revenue_last_n_months: {
            estimated_revenue: 0,
            consultation_fee: 0
          }
        },
        period: `Last ${req.query.months || 6} months`,
        note: 'Statistics unavailable - related tables may not exist',
        requestedBy: req.user?.name
      }, 'Doctor statistics retrieved (empty - tables may not exist)');
    }
  },

  // Get doctor analytics (admin)
  getDoctorAnalytics: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, errors.array()[0].msg, HTTP_STATUS.BAD_REQUEST);
      }
      
      const { id } = req.params;
      const months = parseInt(req.query.months) || 6;
      
      const analytics = await doctorStatsService.getDoctorAnalytics(id, months);
      
      success(res, {
        message: 'Doctor analytics retrieved successfully',
        doctor: analytics.doctor,
        analytics: {
          appointment_statistics: analytics.appointment_statistics,
          monthly_trends: analytics.monthly_trends,
          patient_feedback: analytics.patient_feedback
        },
        period_months: months,
        generated_at: new Date().toLocaleDateString('en-GB')
      }, 'Doctor analytics retrieved successfully');
    } catch (err) {
      logger.error('Error fetching doctor analytics:', err);
      
      if (err.message === 'Doctor not found') {
        return error(res, err.message, HTTP_STATUS.NOT_FOUND);
      }
      
      error(res, 'Failed to retrieve doctor analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  // Get workload analysis
  getWorkloadAnalysis: async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return error(res, errors.array()[0].msg, HTTP_STATUS.BAD_REQUEST);
      }
      
      const days = parseInt(req.query.days) || 30;
      const department = req.query.department;
      
      const analysis = await doctorStatsService.getWorkloadAnalysis(days, department);
      
      success(res, {
        message: 'Doctor workload analysis retrieved successfully',
        workload_analysis: analysis.doctors,
        distribution: analysis.distribution,
        summary: analysis.summary,
        period_days: days,
        department_filter: department || null
      }, 'Workload analysis retrieved successfully');
    } catch (err) {
      logger.error('Error fetching workload analysis:', err);
      error(res, 'Failed to retrieve workload analysis', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};