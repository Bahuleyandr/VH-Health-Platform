// src/services/health/patientHealthService.js
import { TREND_PERIODS } from '../../config/healthConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

function parsePatientId(patientId) {
  const parsed = Number.parseInt(patientId, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Patient not found');
  }
  return parsed;
}

function normalizeDays(days) {
  const parsed = Number.parseInt(days, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return TREND_PERIODS.MONTH;
  }
  return Math.min(parsed, 365);
}

async function getPatientById(patientId) {
  const parsedPatientId = parsePatientId(patientId);
  const patientInfo = await prisma.$queryRawUnsafe(
    'SELECT id, uid, name, phone, email, birthday, gender FROM users WHERE id = $1',
    parsedPatientId
  );

  if (patientInfo.length === 0) {
    throw new Error('Patient not found');
  }

  return patientInfo[0];
}

function toNumberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function formatVitalRecord(record) {
  if (!record) return null;

  return {
    id: record.id,
    date: record.date,
    recorded_date: record.recorded_at,
    vital_signs: {
      bloodPressure: record.blood_pressure || null,
      heartRate: record.heart_rate ?? null,
      temperature: toNumberOrNull(record.temperature),
      bloodSugar: record.blood_sugar ?? null,
      spO2: record.spo2 ?? null,
    },
    measurements: {
      weight: toNumberOrNull(record.weight),
      mood: record.mood || null,
    },
    recorded_by_name: 'Patient self-reported'
  };
}

function getVitalValue(record, vitalType) {
  const aliasMap = {
    blood_pressure: 'bloodPressure',
    bloodPressure: 'bloodPressure',
    heart_rate: 'heartRate',
    heartRate: 'heartRate',
    temperature: 'temperature',
    blood_sugar: 'bloodSugar',
    bloodSugar: 'bloodSugar',
    spo2: 'spO2',
    spO2: 'spO2',
    weight: 'weight',
    mood: 'mood',
  };
  const normalizedType = aliasMap[vitalType] || vitalType;
  return record.vital_signs[normalizedType] ?? record.measurements[normalizedType] ?? null;
}

export async function getPatientSummary(patientId, days = TREND_PERIODS.MONTH) {
  try {
    const safeDays = normalizeDays(days);
    const patient = await getPatientById(patientId);

    const [latestVitals, vitalTrends] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT id, DATE(recorded_at) as date, blood_pressure, heart_rate,
               temperature, blood_sugar, weight, spo2, mood, recorded_at
        FROM patient_vitals
        WHERE patient_uid = $1::uuid
        ORDER BY recorded_at DESC
        LIMIT 1
      `, patient.uid),

      prisma.$queryRawUnsafe(`
        SELECT id, DATE(recorded_at) as date, blood_pressure, heart_rate,
               temperature, blood_sugar, weight, spo2, mood, recorded_at
        FROM patient_vitals
        WHERE patient_uid = $1::uuid
          AND recorded_at >= CURRENT_DATE - ($2 * INTERVAL '1 day')
        ORDER BY recorded_at DESC
      `, patient.uid, safeDays),
    ]);

    return {
      patient,
      latest_vitals: formatVitalRecord(latestVitals[0]),
      vital_trends: vitalTrends.map(formatVitalRecord),
      active_conditions: [],
      recent_medications: [],
      summary_period_days: safeDays
    };
  } catch (error) {
    logger.error(`[PatientHealthService] Error getting patient summary: ${error.message}`);
    throw error;
  }
}

export async function getPatientVitalTrends(patientId, days = TREND_PERIODS.MONTH, vitalType = null) {
  try {
    const safeDays = normalizeDays(days);
    const patient = await getPatientById(patientId);

    const result = await prisma.$queryRawUnsafe(`
      SELECT id, DATE(recorded_at) as date, blood_pressure, heart_rate,
             temperature, blood_sugar, weight, spo2, mood, recorded_at
      FROM patient_vitals
      WHERE patient_uid = $1::uuid
        AND recorded_at >= CURRENT_DATE - ($2 * INTERVAL '1 day')
      ORDER BY recorded_at ASC
    `, patient.uid, safeDays);

    const trends = result.map(formatVitalRecord);
    
    // Filter by specific vital type if requested
    let filteredData = trends;
    if (vitalType && trends.length > 0) {
      filteredData = trends.map(trend => ({
        date: trend.date,
        recorded_date: trend.recorded_date,
        value: getVitalValue(trend, vitalType)
      })).filter(item => item.value !== null);
    }
    
    return {
      trends: filteredData,
      count: filteredData.length,
      patient_id: patientId,
      period_days: safeDays,
      vital_type: vitalType || 'all'
    };
  } catch (error) {
    logger.error(`[PatientHealthService] Error getting vital trends: ${error.message}`);
    throw error;
  }
}

export async function getPatientAllergies(patientId) {
  try {
    const patient = await getPatientById(patientId);
    
    return {
      allergies: [],
      count: 0,
      patient: {
        id: patient.id,
        name: patient.name,
        phone: patient.phone
      }
    };
  } catch (error) {
    logger.error(`[PatientHealthService] Error getting patient allergies: ${error.message}`);
    throw error;
  }
}

export async function getPatientConditions(patientId, activeOnly = false) {
  try {
    await getPatientById(patientId);
    
    return {
      conditions: [],
      count: 0,
      patient_id: patientId,
      active_only: activeOnly
    };
  } catch (error) {
    logger.error(`[PatientHealthService] Error getting patient conditions: ${error.message}`);
    throw error;
  }
}
