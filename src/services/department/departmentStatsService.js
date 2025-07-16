// src/services/department/departmentStatsService.js
import db from '../../config/database.js';
import { DEPARTMENT_CONFIG } from '../../config/departmentConfig.js';
import logger from '../../logging/logger.js';
import { formatDate } from '../../utils/department/departmentHelpers.js';

class DepartmentStatsService {
  async getDepartmentStats(id) {
    try {
      // Get department info
      const deptResult = await db.query(
        'SELECT name FROM departments WHERE id = $1 AND is_active = true', 
        [id]
      );
      
      if (deptResult.rows.length === 0) {
        return null;
      }
      
      const departmentName = deptResult.rows[0].name;
      
      // Get various statistics
      const [doctorStats, appointmentStats, recordStats] = await Promise.all([
        // Doctor statistics
        db.query(`
          SELECT 
            COUNT(*) as total_doctors,
            COUNT(CASE WHEN is_available = true THEN 1 END) as available_doctors,
            ROUND(AVG(experience_years), 1) as avg_experience,
            ROUND(AVG(consultation_fee), 2) as avg_consultation_fee,
            COUNT(DISTINCT specialization) as specialization_count
          FROM doctors 
          WHERE LOWER(department) = LOWER($1)
        `, [departmentName]),
        
        // Appointment statistics (last 30 days)
        db.query(`
          SELECT 
            COUNT(*) as total_appointments,
            COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed_appointments,
            COUNT(CASE WHEN status = 'SCHEDULED' THEN 1 END) as scheduled_appointments,
            COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
            COUNT(DISTINCT patient_id) as unique_patients
          FROM appointments a
          JOIN users d ON a.doctor_id = d.id
          JOIN doctors doc ON d.id = doc.user_id
          WHERE LOWER(doc.department) = LOWER($1) AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
        `, [departmentName]),
        
        // Medical records statistics (last 30 days)
        db.query(`
          SELECT 
            COUNT(*) as total_records,
            COUNT(DISTINCT patient_id) as unique_patients
          FROM medical_records r
          JOIN users d ON r.doctor_id = d.id
          JOIN doctors doc ON d.id = doc.user_id
          WHERE LOWER(doc.department) = LOWER($1) AND r.created_at >= CURRENT_DATE - INTERVAL '30 days'
        `, [departmentName])
      ]);
      
      // Parse numeric values
      const doctorStatsData = {
        total_doctors: parseInt(doctorStats.rows[0].total_doctors),
        available_doctors: parseInt(doctorStats.rows[0].available_doctors),
        avg_experience: parseFloat(doctorStats.rows[0].avg_experience) || 0,
        avg_consultation_fee: parseFloat(doctorStats.rows[0].avg_consultation_fee) || 0,
        specialization_count: parseInt(doctorStats.rows[0].specialization_count)
      };

      const appointmentStatsData = {
        total_appointments: parseInt(appointmentStats.rows[0].total_appointments),
        completed_appointments: parseInt(appointmentStats.rows[0].completed_appointments),
        scheduled_appointments: parseInt(appointmentStats.rows[0].scheduled_appointments),
        cancelled_appointments: parseInt(appointmentStats.rows[0].cancelled_appointments),
        unique_patients: parseInt(appointmentStats.rows[0].unique_patients),
        completion_rate: appointmentStats.rows[0].total_appointments > 0 
          ? (appointmentStats.rows[0].completed_appointments / appointmentStats.rows[0].total_appointments * 100).toFixed(1) 
          : 0
      };

      const recordStatsData = {
        total_records: parseInt(recordStats.rows[0].total_records),
        unique_patients: parseInt(recordStats.rows[0].unique_patients)
      };
      
      return {
        department: departmentName,
        statistics: {
          doctors: doctorStatsData,
          appointments_last_30_days: appointmentStatsData,
          medical_records_last_30_days: recordStatsData
        },
        period: 'Last 30 days'
      };
    } catch (error) {
      logger.error('Database error in getDepartmentStats:', error);
      
      // Return empty statistics on error
      return {
        department: id,
        statistics: {
          doctors: {
            total_doctors: 0,
            available_doctors: 0,
            avg_experience: 0,
            avg_consultation_fee: 0,
            specialization_count: 0
          },
          appointments_last_30_days: {
            total_appointments: 0,
            completed_appointments: 0,
            scheduled_appointments: 0,
            cancelled_appointments: 0,
            unique_patients: 0,
            completion_rate: 0
          },
          medical_records_last_30_days: {
            total_records: 0,
            unique_patients: 0
          }
        },
        period: 'Last 30 days',
        note: 'Statistics unavailable - related tables may not exist'
      };
    }
  }

  async getDepartmentPerformanceMetrics(id, days = 30) {
    try {
      // Get department name first
      const deptResult = await db.query(
        'SELECT name FROM departments WHERE id = $1 AND is_active = true', 
        [id]
      );
      
      if (deptResult.rows.length === 0) {
        throw new Error('Department not found');
      }
      
      const departmentName = deptResult.rows[0].name;
      
      const result = await db.query(`
        SELECT 
          DATE(a.appointment_date) as date,
          COUNT(*) as total_appointments,
          COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed,
          COUNT(CASE WHEN a.status = 'CANCELLED' THEN 1 END) as cancelled,
          AVG(CASE WHEN a.status = 'COMPLETED' THEN doc.consultation_fee END) as avg_revenue
        FROM appointments a
        JOIN users d ON a.doctor_id = d.id
        JOIN doctors doc ON d.id = doc.user_id
        WHERE LOWER(doc.department) = LOWER($1) 
          AND a.appointment_date >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY DATE(a.appointment_date)
        ORDER BY date DESC
      `, [departmentName]);
      
      return result.rows.map(row => ({
        date: formatDate(row.date),
        total_appointments: parseInt(row.total_appointments),
        completed: parseInt(row.completed),
        cancelled: parseInt(row.cancelled),
        avg_revenue: parseFloat(row.avg_revenue) || 0,
        completion_rate: row.total_appointments > 0 
          ? ((row.completed / row.total_appointments) * 100).toFixed(1)
          : 0
      }));
    } catch (error) {
      logger.error('Error getting performance metrics:', error);
      throw error;
    }
  }

  async getDepartmentTrends(id, months = 6) {
    try {
      // Get department name first
      const deptResult = await db.query(
        'SELECT name FROM departments WHERE id = $1 AND is_active = true', 
        [id]
      );
      
      if (deptResult.rows.length === 0) {
        throw new Error('Department not found');
      }
      
      const departmentName = deptResult.rows[0].name;
      
      const result = await db.query(`
        SELECT 
          DATE_TRUNC('month', a.appointment_date) as month,
          COUNT(*) as appointments,
          COUNT(DISTINCT a.patient_id) as unique_patients,
          SUM(CASE WHEN a.status = 'COMPLETED' THEN doc.consultation_fee ELSE 0 END) as revenue,
          AVG(CASE WHEN a.status = 'COMPLETED' THEN doc.consultation_fee ELSE NULL END) as avg_consultation_fee
        FROM appointments a
        JOIN users d ON a.doctor_id = d.id
        JOIN doctors doc ON d.id = doc.user_id
        WHERE LOWER(doc.department) = LOWER($1) 
          AND a.appointment_date >= CURRENT_DATE - INTERVAL '${months} months'
        GROUP BY DATE_TRUNC('month', a.appointment_date)
        ORDER BY month
      `, [departmentName]);
      
      return result.rows.map(row => ({
        month: formatDate(row.month, 'MM-YYYY'),
        appointments: parseInt(row.appointments),
        unique_patients: parseInt(row.unique_patients),
        revenue: parseFloat(row.revenue) || 0,
        avg_consultation_fee: parseFloat(row.avg_consultation_fee) || 0
      }));
    } catch (error) {
      logger.error('Error getting department trends:', error);
      throw error;
    }
  }

  async getDepartmentComparisonStats() {
    try {
      const result = await db.query(`
        SELECT 
          d.name,
          COUNT(DISTINCT doc.user_id) as doctor_count,
          COUNT(DISTINCT a.id) as appointment_count,
          COUNT(DISTINCT a.patient_id) as patient_count,
          AVG(doc.consultation_fee) as avg_consultation_fee,
          SUM(CASE WHEN a.status = 'COMPLETED' THEN doc.consultation_fee ELSE 0 END) as total_revenue,
          COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END)::float / 
            NULLIF(COUNT(a.id), 0) * 100 as completion_rate
        FROM departments d
        LEFT JOIN doctors doc ON doc.department = d.name
        LEFT JOIN appointments a ON doc.user_id = a.doctor_id 
          AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
        WHERE d.is_active = true
        GROUP BY d.name
        ORDER BY total_revenue DESC NULLS LAST
      `);
      
      return result.rows.map(row => ({
        name: row.name,
        doctor_count: parseInt(row.doctor_count),
        appointment_count: parseInt(row.appointment_count),
        patient_count: parseInt(row.patient_count),
        avg_consultation_fee: parseFloat(row.avg_consultation_fee) || 0,
        total_revenue: parseFloat(row.total_revenue) || 0,
        completion_rate: parseFloat(row.completion_rate) || 0
      }));
    } catch (error) {
      logger.error('Error getting department comparison:', error);
      throw new Error('Failed to retrieve department comparison');
    }
  }
}

export default new DepartmentStatsService();