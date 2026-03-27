import db from '../../config/database.js';
import logger from '../../logging/logger.js';

/**
 * Clinical reference ranges for vital signs.
 * When a recorded vital falls outside these ranges, an alert is generated.
 */
const VITAL_REFERENCE_RANGES = {
  heart_rate: { min: 40, max: 150, critical_min: 30, critical_max: 180, unit: 'bpm' },
  systolic_bp: { min: 80, max: 160, critical_min: 60, critical_max: 200, unit: 'mmHg' },
  diastolic_bp: { min: 50, max: 100, critical_min: 40, critical_max: 120, unit: 'mmHg' },
  temperature: { min: 35.5, max: 38.5, critical_min: 34.0, critical_max: 40.0, unit: '°C' },
  oxygen_saturation: { min: 92, max: 100, critical_min: 85, critical_max: 100, unit: '%' },
  respiratory_rate: { min: 10, max: 24, critical_min: 6, critical_max: 35, unit: '/min' },
  blood_glucose: { min: 70, max: 180, critical_min: 50, critical_max: 400, unit: 'mg/dL' },
};

/**
 * Check vitals against reference ranges and generate alerts for abnormal values.
 * Call this after any vital sign is recorded.
 * @param {number} patientId - Patient DB ID
 * @param {Object} vitals - { heart_rate, systolic_bp, diastolic_bp, temperature, oxygen_saturation, ... }
 * @param {Object} context - { recordedBy, requestId }
 * @returns {Array} alerts - Array of generated alerts
 */
export async function checkVitalAnomalies(patientId, vitals, context = {}) {
  const alerts = [];

  for (const [vitalName, value] of Object.entries(vitals)) {
    if (value == null || !VITAL_REFERENCE_RANGES[vitalName]) continue;

    const range = VITAL_REFERENCE_RANGES[vitalName];
    const numValue = parseFloat(value);
    if (isNaN(numValue)) continue;

    let severity = null;
    if (numValue <= range.critical_min || numValue >= range.critical_max) {
      severity = 'CRITICAL';
    } else if (numValue < range.min || numValue > range.max) {
      severity = 'WARNING';
    }

    if (severity) {
      const alert = {
        patient_id: patientId,
        vital_name: vitalName,
        value: numValue,
        unit: range.unit,
        severity,
        normal_range: `${range.min}-${range.max}`,
        message: `${vitalName.replace(/_/g, ' ')} ${numValue}${range.unit} is ${severity === 'CRITICAL' ? 'critically' : ''} ${numValue < range.min ? 'low' : 'high'} (normal: ${range.min}-${range.max}${range.unit})`,
        recorded_by: context.recordedBy,
      };
      alerts.push(alert);
    }
  }

  // Persist alerts to database (fire-and-forget)
  if (alerts.length > 0) {
    setImmediate(async () => {
      try {
        for (const alert of alerts) {
          await db.query(
            `INSERT INTO clinical_alerts (patient_id, alert_type, vital_name, vital_value, severity, message, created_by, created_at)
             VALUES ($1, 'VITAL_ANOMALY', $2, $3, $4, $5, $6, NOW())`,
            [alert.patient_id, alert.vital_name, alert.value, alert.severity, alert.message, alert.recorded_by]
          );
        }
        logger.warn(`Clinical alerts generated for patient ${patientId}:`, alerts.map(a => `${a.vital_name}=${a.value} (${a.severity})`).join(', '));
      } catch (err) {
        logger.error('Failed to persist clinical alerts:', err.message);
      }
    });
  }

  return alerts;
}

export { VITAL_REFERENCE_RANGES };
export default { checkVitalAnomalies, VITAL_REFERENCE_RANGES };
