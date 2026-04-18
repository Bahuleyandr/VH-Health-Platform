// src/services/doctor/doctorStatsService.js
import { DOCTOR_CONFIG, DOCTOR_MESSAGES } from '../../config/doctorConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

export class DoctorStatsService {
  // Get doctor statistics
  async getDoctorStats(doctorId, months = 6) {
    try {
      const [appointmentStats, patientStats, revenueStats] = await Promise.all([
        // Appointment statistics
        prisma.$queryRawUnsafe(`
          SELECT 
            COUNT(*) as total_appointments,
            COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed_appointments,
            COUNT(CASE WHEN status = 'SCHEDULED' THEN 1 END) as scheduled_appointments,
            COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
            ROUND(COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as completion_rate
          FROM appointments 
          WHERE doctor_id = $1 AND appointment_date >= CURRENT_DATE - INTERVAL '${months} months'
        `, doctorId),
        
        // Patient statistics
        prisma.$queryRawUnsafe(`
          SELECT 
            COUNT(DISTINCT patient_id) as unique_patients,
            COUNT(*) as total_consultations
          FROM appointments 
          WHERE doctor_id = $1 AND status = 'COMPLETED'
        `, doctorId),
        
        // Revenue statistics
        prisma.$queryRawUnsafe(`
          SELECT 
            COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) * d.consultation_fee as estimated_revenue,
            d.consultation_fee
          FROM appointments a
          JOIN doctors d ON a.doctor_id = d.user_id
          WHERE a.doctor_id = $1 AND a.appointment_date >= CURRENT_DATE - INTERVAL '${months} months'
          GROUP BY d.consultation_fee
        `, doctorId)
      ]);
      
      return {
        appointments: appointmentStats[0],
        patients: patientStats[0],
        revenue: revenueStats[0] || { estimated_revenue: 0, consultation_fee: 0 }
      };
    } catch (error) {
      logger.error('Error fetching doctor statistics:', error);
      throw error;
    }
  }

  // Get doctor performance analytics
  async getDoctorAnalytics(doctorId, months = 6) {
    try {
      // Verify doctor exists
      const doctorCheck = await prisma.$queryRawUnsafe(
        'SELECT u.name, d.specialization, d.department FROM users u JOIN doctors d ON u.id = d.user_id WHERE u.id = $1',
        doctorId
      );
      
      if (doctorCheck.length === 0) {
        throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
      }
      
      const [appointmentStats, monthlyTrends, patientFeedback] = await Promise.all([
        // Appointment statistics
        prisma.$queryRawUnsafe(`
          SELECT 
            COUNT(*) as total_appointments,
            COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed_appointments,
            COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
            COUNT(CASE WHEN status = 'NO_SHOW' THEN 1 END) as no_show_appointments,
            ROUND(COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as completion_rate
          FROM appointments 
          WHERE doctor_id = $1 AND appointment_date >= CURRENT_DATE - INTERVAL '${months} months'
        `, doctorId),
        
        // Monthly trends
        prisma.$queryRawUnsafe(`
          SELECT 
            TO_CHAR(DATE_TRUNC('month', appointment_date), 'MM-YYYY') as month,
            COUNT(*) as total_appointments,
            COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed_appointments,
            SUM(CASE WHEN status = 'COMPLETED' THEN d.consultation_fee ELSE 0 END) as revenue
          FROM appointments a
          JOIN doctors d ON a.doctor_id = d.user_id
          WHERE a.doctor_id = $1 AND a.appointment_date >= CURRENT_DATE - INTERVAL '${months} months'
          GROUP BY DATE_TRUNC('month', appointment_date)
          ORDER BY DATE_TRUNC('month', appointment_date) DESC
        `, doctorId),
        
        // Patient feedback (if table exists)
        prisma.$queryRawUnsafe(`
          SELECT AVG(rating) as avg_rating, COUNT(*) as total_reviews,
                 COUNT(CASE WHEN rating >= 4 THEN 1 END) as positive_reviews
          FROM patient_feedback 
          WHERE doctor_id = $1 AND created_at >= CURRENT_DATE - INTERVAL '${months} months'
        `, doctorId).catch(() => ({
          rows: [{ avg_rating: null, total_reviews: 0, positive_reviews: 0 }]
        }))
      ]);
      
      return {
        doctor: doctorCheck[0],
        appointment_statistics: appointmentStats[0],
        monthly_trends: monthlyTrends,
        patient_feedback: patientFeedback[0]
      };
    } catch (error) {
      logger.error('Error fetching doctor analytics:', error);
      throw error;
    }
  }

  // Get workload analysis
  async getWorkloadAnalysis(days = 30, department = null) {
    try {
      let query = `
        SELECT u.id, u.name, d.specialization, d.department,
               d.available_days, d.available_hours,
               COUNT(a.id) as total_appointments,
               COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments,
               COUNT(CASE WHEN a.status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
               ROUND(COUNT(a.id)::numeric / $1, 2) as avg_appointments_per_day,
               CASE 
                 WHEN COUNT(a.id) > ${DOCTOR_CONFIG.WORKLOAD_LEVELS.HIGH.min} THEN 'HIGH'
                 WHEN COUNT(a.id) > ${DOCTOR_CONFIG.WORKLOAD_LEVELS.MEDIUM.min} THEN 'MEDIUM'
                 ELSE 'LOW'
               END as workload_level,
               SUM(CASE WHEN a.status = 'COMPLETED' THEN d.consultation_fee ELSE 0 END) as revenue
        FROM users u
        JOIN doctors d ON u.id = d.user_id
        LEFT JOIN appointments a ON u.id = a.doctor_id 
          AND a.appointment_date >= CURRENT_DATE - INTERVAL '${days} days'
        WHERE u.role = 'DOCTOR' AND d.is_available = true
      `;
      const params = [days];
      
      if (department) {
        query += ' AND d.department = $2';
        params.push(department);
      }
      
      query += ` GROUP BY u.id, u.name, d.specialization, d.department, 
                 d.available_days, d.available_hours, d.consultation_fee
                 ORDER BY total_appointments DESC`;
      
      const result = await prisma.$queryRawUnsafe(query, params);
      
      // Calculate workload distribution
      const workloadDistribution = result.reduce((acc, doctor) => {
        const level = doctor.workload_level;
        acc[level] = (acc[level] || 0) + 1;
        return acc;
      }, {});
      
      return {
        doctors: result,
        distribution: workloadDistribution,
        summary: {
          total_doctors: result.length,
          avg_appointments: Math.round(
            result.reduce((sum, d) => sum + parseInt(d.total_appointments), 0) / result.length
          ),
          high_workload_doctors: result.filter(d => d.workload_level === 'HIGH').length
        },
        period_days: days,
        department_filter: department
      };
    } catch (error) {
      logger.error('Error fetching workload analysis:', error);
      throw error;
    }
  }
}

export const doctorStatsService = new DoctorStatsService();