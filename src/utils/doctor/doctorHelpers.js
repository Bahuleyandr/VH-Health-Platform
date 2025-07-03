// src/utils/doctor/doctorHelpers.js
import { DOCTOR_CONFIG } from '../../config/doctorConfig.js';

/**
 * Format doctor data for response
 */
export const formatDoctorResponse = (doctor, userRole = 'PATIENT') => {
  if (!doctor) return null;
  
  // Create base response
  const response = {
    id: doctor.id,
    uid: doctor.uid,
    name: doctor.name,
    specialization: doctor.specialization,
    department: doctor.department,
    experience_years: doctor.experience_years,
    consultation_fee: doctor.consultation_fee,
    is_available: doctor.is_available,
    bio: doctor.bio,
    profile_picture: doctor.profile_picture
  };
  
  // Add sensitive data based on role
  if (['ADMIN', 'DOCTOR', 'NURSE'].includes(userRole)) {
    response.phone = doctor.phone;
    response.email = doctor.email;
    response.address = doctor.address;
    response.birthday = doctor.birthday;
    response.gender = doctor.gender;
  }
  
  // Add availability info
  if (doctor.available_days) {
    response.available_days = Array.isArray(doctor.available_days) 
      ? doctor.available_days 
      : doctor.available_days.split(',').map(d => d.trim());
  }
  
  if (doctor.available_hours) {
    response.available_hours = doctor.available_hours;
  }
  
  // Add education and qualifications
  if (doctor.education) {
    response.education = doctor.education;
  }
  
  if (doctor.qualifications) {
    response.qualifications = Array.isArray(doctor.qualifications)
      ? doctor.qualifications
      : doctor.qualifications.split(',').map(q => q.trim());
  }
  
  return response;
};

/**
 * Get experience level based on years
 */
export const getExperienceLevel = (years) => {
  for (const [level, config] of Object.entries(DOCTOR_CONFIG.EXPERIENCE_LEVELS)) {
    if (years >= config.min && (config.max === null || years <= config.max)) {
      return {
        level,
        label: config.label
      };
    }
  }
  return { level: 'JUNIOR', label: 'Junior Doctor' };
};

/**
 * Parse working hours
 */
export const parseWorkingHours = (hoursString) => {
  if (!hoursString) return null;
  
  const match = hoursString.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) return null;
  
  return {
    start: { hour: parseInt(match[1]), minute: parseInt(match[2]) },
    end: { hour: parseInt(match[3]), minute: parseInt(match[4]) }
  };
};

/**
 * Check if doctor is available now
 */
export const isDoctorAvailableNow = (doctor) => {
  if (!doctor.is_available) return false;
  
  const now = new Date();
  const currentDay = now.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  
  // Check day
  if (doctor.available_days && !doctor.available_days.includes(currentDay)) {
    return false;
  }
  
  // Check time
  if (doctor.available_hours) {
    const hours = parseWorkingHours(doctor.available_hours);
    if (!hours) return true; // If can't parse, assume available
    
    const currentTime = currentHour * 60 + currentMinute;
    const startTime = hours.start.hour * 60 + hours.start.minute;
    const endTime = hours.end.hour * 60 + hours.end.minute;
    
    return currentTime >= startTime && currentTime <= endTime;
  }
  
  return true;
};

/**
 * Calculate workload level
 */
export const calculateWorkloadLevel = (appointmentCount) => {
  if (appointmentCount >= DOCTOR_CONFIG.WORKLOAD_LEVELS.HIGH.min) {
    return 'HIGH';
  } else if (appointmentCount >= DOCTOR_CONFIG.WORKLOAD_LEVELS.MEDIUM.min) {
    return 'MEDIUM';
  }
  return 'LOW';
};

/**
 * Validate specialization for department
 */
export const isValidSpecialization = (department, specialization) => {
  const validSpecializations = DOCTOR_CONFIG.SPECIALIZATIONS[department];
  if (!validSpecializations) return false;
  
  return validSpecializations.includes(specialization);
};

/**
 * Format date to DD-MM-YYYY
 */
export const formatDate = (date) => {
  if (!date) return null;
  
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  
  return `${day}-${month}-${year}`;
};

/**
 * Format time to HH:mm
 */
export const formatTime = (time) => {
  if (!time) return null;
  
  if (typeof time === 'string' && time.match(/^\d{2}:\d{2}$/)) {
    return time;
  }
  
  const [hours, minutes] = time.split(':');
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

/**
 * Generate doctor availability summary
 */
export const generateAvailabilitySummary = (doctor) => {
  if (!doctor.is_available) {
    return 'Currently unavailable';
  }
  
  const days = doctor.available_days || 'All days';
  const hours = doctor.available_hours || 'Regular hours';
  
  return `Available: ${days}, ${hours}`;
};

/**
 * Filter doctors by availability
 */
export const filterAvailableDoctors = (doctors, options = {}) => {
  const { includeUnavailable = false, checkCurrentTime = false } = options;
  
  return doctors.filter(doctor => {
    if (!includeUnavailable && !doctor.is_available) {
      return false;
    }
    
    if (checkCurrentTime && !isDoctorAvailableNow(doctor)) {
      return false;
    }
    
    return true;
  });
};