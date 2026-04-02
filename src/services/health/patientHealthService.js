// src/services/health/patientHealthService.js
import prisma from '../../lib/prisma.js';
import { createPrismaDb } from '../../lib/prismaCompat.js';
import { TREND_PERIODS } from '../../config/healthConfig.js';
import logger from '../../logging/logger.js';

const db = createPrismaDb(prisma);

export async function getPatientSummary(patientId, days = TREND_PERIODS.MONTH) {
  try {
    // Get patient basic info
    const patientInfo = await prisma.$queryRawUnsafe(
      'SELECT name, phone, email, birthday, gender FROM users WHERE id = $1',
      [patientId]
    );
    
    if (patientInfo.rows.length === 0) {
      throw new Error('Patient not found');
    }
    
    // Get comprehensive health data
    const [latestVitals, vitalTrends, activeConditions, medications] = await Promise.all([
      // Latest vitals
      prisma.$queryRawUnsafe(`
        SELECT vital_signs, measurements, recorded_date, r.name as recorded_by_name
        FROM health_records h
        LEFT JOIN users r ON h.recorded_by = r.id
        WHERE h.patient_id = $1 AND h.record_type = 'VITALS'
        ORDER BY h.recorded_date DESC
        LIMIT 1
      `, [patientId]),
      
      // Vital trends
      prisma.$queryRawUnsafe(`
        SELECT DATE(recorded_date) as date, vital_signs, measurements
        FROM health_records 
        WHERE patient_id = $1 AND record_type = 'VITALS'
          AND recorded_date >= CURRENT_DATE - INTERVAL '${days} days'
        ORDER BY recorded_date DESC
      `, [patientId]),
      
      // Active conditions
      prisma.$queryRawUnsafe(`
        SELECT id, symptoms, notes, recorded_date
        FROM health_records 
        WHERE patient_id = $1 AND record_type = 'CONDITION'
        ORDER BY recorded_date DESC
        LIMIT 10
      `, [patientId]),
      
      // Medications
      prisma.$queryRawUnsafe(`
        SELECT id, notes as medication_details, recorded_date
        FROM health_records 
        WHERE patient_id = $1 AND record_type = 'MEDICATION'
        ORDER BY recorded_date DESC
        LIMIT 10
      `, [patientId])
    ]);
    
    return {
      patient: patientInfo[0],
      latest_vitals: latestVitals[0] || null,
      vital_trends: vitalTrends.rows,
      active_conditions: activeConditions.rows,
      recent_medications: medications.rows,
      summary_period_days: days
    };
  } catch (error) {
    logger.error(`[PatientHealthService] Error getting patient summary: ${error.message}`);
    throw error;
  }
}

export async function getPatientVitalTrends(patientId, days = TREND_PERIODS.MONTH, vitalType = null) {
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT DATE(recorded_date) as date, vital_signs, measurements, recorded_date
      FROM health_records 
      WHERE patient_id = $1 AND record_type = 'VITALS'
        AND recorded_date >= CURRENT_DATE - INTERVAL '${days} days'
      ORDER BY recorded_date ASC
    `, [patientId]);
    
    // Process data to extract specific vital trends
    const trends = result.rows.map(record => {
      let vitalSigns = {};
      let measurements = {};
      
      try {
        vitalSigns = typeof record.vital_signs === 'string' 
          ? JSON.parse(record.vital_signs) 
          : record.vital_signs || {};
        measurements = typeof record.measurements === 'string'
          ? JSON.parse(record.measurements)
          : record.measurements || {};
      } catch (e) {
        logger.warn('Failed to parse vital signs data:', e.message);
      }
      
      return {
        date: record.date,
        recorded_date: record.recorded_date,
        vital_signs: vitalSigns,
        measurements: measurements
      };
    });
    
    // Filter by specific vital type if requested
    let filteredData = trends;
    if (vitalType && trends.length > 0) {
      filteredData = trends.map(trend => ({
        date: trend.date,
        recorded_date: trend.recorded_date,
        value: trend.vital_signs[vitalType] || trend.measurements[vitalType] || null
      })).filter(item => item.value !== null);
    }
    
    return {
      trends: filteredData,
      count: filteredData.length,
      patient_id: patientId,
      period_days: days,
      vital_type: vitalType || 'all'
    };
  } catch (error) {
    logger.error(`[PatientHealthService] Error getting vital trends: ${error.message}`);
    throw error;
  }
}

export async function getPatientAllergies(patientId) {
  try {
    const [allergies, patientInfo] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT h.id, h.symptoms, h.notes, h.recorded_date,
               r.name as recorded_by_name
        FROM health_records h
        LEFT JOIN users r ON h.recorded_by = r.id
        WHERE h.patient_id = $1 AND h.record_type = 'ALLERGY'
        ORDER BY h.recorded_date DESC
      `, [patientId]),
      
      prisma.$queryRawUnsafe('SELECT name, phone FROM users WHERE id = $1', [patientId])
    ]);
    
    return {
      allergies: allergies.rows,
      count: allergies.rows.length,
      patient: patientInfo[0] || null
    };
  } catch (error) {
    logger.error(`[PatientHealthService] Error getting patient allergies: ${error.message}`);
    throw error;
  }
}

export async function getPatientConditions(patientId, activeOnly = false) {
  try {
    let query = `
      SELECT h.id, h.symptoms, h.notes, h.recorded_date,
             r.name as recorded_by_name, r.role as recorded_by_role
      FROM health_records h
      LEFT JOIN users r ON h.recorded_by = r.id
      WHERE h.patient_id = $1 AND h.record_type = 'CONDITION'
    `;
    const params = [patientId];
    
    if (activeOnly) {
      query += ' AND h.recorded_date >= CURRENT_DATE - INTERVAL \'180 days\'';
    }
    
    query += ' ORDER BY h.recorded_date DESC';
    
    const result = await prisma.$queryRawUnsafe(query, params);
    
    return {
      conditions: result.rows,
      count: result.rows.length,
      patient_id: patientId,
      active_only: activeOnly
    };
  } catch (error) {
    logger.error(`[PatientHealthService] Error getting patient conditions: ${error.message}`);
    throw error;
  }
}