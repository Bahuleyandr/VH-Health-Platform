// src/utils/health/healthHelpers.js
import { VITAL_SIGNS } from '../../config/healthConfig.js';

export function parseVitalSigns(vitalSignsData) {
  if (!vitalSignsData) {return {};}
  
  try {
    return typeof vitalSignsData === 'string' 
      ? JSON.parse(vitalSignsData) 
      : vitalSignsData;
  } catch (error) {
    return {};
  }
}

export function parseMeasurements(measurementsData) {
  if (!measurementsData) {return {};}
  
  try {
    return typeof measurementsData === 'string' 
      ? JSON.parse(measurementsData) 
      : measurementsData;
  } catch (error) {
    return {};
  }
}

export function formatVitalSign(type, value) {
  switch (type) {
    case VITAL_SIGNS.BLOOD_PRESSURE:
      return `${value} mmHg`;
    case VITAL_SIGNS.HEART_RATE:
      return `${value} bpm`;
    case VITAL_SIGNS.TEMPERATURE:
      return `${value}°C`;
    case VITAL_SIGNS.OXYGEN_SATURATION:
      return `${value}%`;
    case VITAL_SIGNS.RESPIRATORY_RATE:
      return `${value} breaths/min`;
    case VITAL_SIGNS.BLOOD_SUGAR:
      return `${value} mg/dL`;
    case VITAL_SIGNS.WEIGHT:
      return `${value} kg`;
    case VITAL_SIGNS.HEIGHT:
      return `${value} cm`;
    default:
      return value;
  }
}

export function calculateBMI(weightKg, heightCm) {
  if (!weightKg || !heightCm || heightCm === 0) {return null;}
  
  const heightM = heightCm / 100;
  const bmi = weightKg / (heightM * heightM);
  
  return {
    value: Math.round(bmi * 10) / 10,
    category: getBMICategory(bmi)
  };
}

function getBMICategory(bmi) {
  if (bmi < 18.5) {return 'Underweight';}
  if (bmi < 25) {return 'Normal weight';}
  if (bmi < 30) {return 'Overweight';}
  return 'Obese';
}

export function isVitalSignCritical(type, value) {
  const criticalRanges = {
    [VITAL_SIGNS.HEART_RATE]: { min: 40, max: 130 },
    [VITAL_SIGNS.OXYGEN_SATURATION]: { min: 90, max: 100 },
    [VITAL_SIGNS.TEMPERATURE]: { min: 35, max: 39 },
    [VITAL_SIGNS.BLOOD_SUGAR]: { min: 70, max: 180 }
  };
  
  const range = criticalRanges[type];
  if (!range) {return false;}
  
  return value < range.min || value > range.max;
}

export function formatDateForDisplay(date) {
  if (!date) {return null;}
  return new Date(date).toLocaleDateString('en-GB');
}

export function formatDateTimeForDisplay(date) {
  if (!date) {return null;}
  const d = new Date(date);
  return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { 
    hour: '2-digit', 
    minute: '2-digit' 
  });
}