// src/utils/department/departmentHelpers.js
import { DEPARTMENT_CONFIG } from '../../config/departmentConfig.js';

/**
 * Format date to DD-MM-YYYY format
 * @param {Date|string} date - Date to format
 * @param {string} format - Format type (default: DD-MM-YYYY)
 * @returns {string} Formatted date string
 */
export function formatDate(date, format = 'DD-MM-YYYY') {
  if (!date) {return null;}
  
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  
  if (format === 'MM-YYYY') {
    return `${month}-${year}`;
  }
  
  return `${day}-${month}-${year}`;
}

/**
 * Format time to HH:mm format
 * @param {string} time - Time string to format
 * @returns {string} Formatted time string
 */
export function formatTime(time) {
  if (!time) {return null;}
  
  // If time is already in HH:mm format, return as is
  if (/^\d{2}:\d{2}$/.test(time)) {
    return time;
  }
  
  // Parse and format time
  const [hours, minutes] = time.split(':');
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
}

/**
 * Get current day in uppercase format
 * @returns {string} Current day (e.g., 'MONDAY')
 */
export function getCurrentDay() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
}

/**
 * Calculate department performance score
 * @param {Object} stats - Department statistics
 * @returns {number} Performance score (0-100)
 */
export function calculatePerformanceScore(stats) {
  const {
    completed_appointments = 0,
    total_appointments = 0,
    available_doctors = 0,
    total_doctors = 0
  } = stats;
  
  // Calculate appointment completion rate (40% weight)
  const completionRate = total_appointments > 0 
    ? (completed_appointments / total_appointments) 
    : 0;
  
  // Calculate doctor availability rate (30% weight)
  const availabilityRate = total_doctors > 0 
    ? (available_doctors / total_doctors) 
    : 0;
  
  // Calculate efficiency score (30% weight)
  const efficiencyScore = total_appointments > 0 && total_doctors > 0
    ? Math.min((completed_appointments / (total_doctors * 20)), 1) // Assuming 20 appointments per doctor is optimal
    : 0;
  
  const performanceScore = (
    (completionRate * 0.4) + 
    (availabilityRate * 0.3) + 
    (efficiencyScore * 0.3)
  ) * 100;
  
  return Math.round(performanceScore);
}

/**
 * Format currency amount
 * @param {number} amount - Amount to format
 * @param {string} currency - Currency code (default: INR)
 * @returns {string} Formatted currency string
 */
export function formatCurrency(amount, currency = DEPARTMENT_CONFIG.DEFAULT_CURRENCY) {
  if (isNaN(amount)) {return '0.00';}
  
  const formatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  
  return formatter.format(amount);
}

/**
 * Validate department budget
 * @param {number} budget - Budget amount
 * @returns {boolean} Is valid budget
 */
export function isValidBudget(budget) {
  return !isNaN(budget) && 
         budget >= DEPARTMENT_CONFIG.MIN_BUDGET && 
         budget <= DEPARTMENT_CONFIG.MAX_BUDGET;
}

/**
 * Check if department meets minimum requirements
 * @param {Object} department - Department object
 * @returns {Object} Requirements check result
 */
export function checkDepartmentRequirements(department) {
  const requirements = {
    hasMinimumDoctors: department.doctor_count >= DEPARTMENT_CONFIG.MIN_DOCTORS_FOR_ACTIVE,
    hasHeadDoctor: !!department.head_doctor_id,
    hasContactNumber: !!department.contact_number,
    hasLocation: !!department.location,
    isActive: department.is_active
  };
  
  requirements.meetsAllRequirements = Object.values(requirements).every(req => req === true);
  
  return requirements;
}

/**
 * Calculate department utilization rate
 * @param {number} actualAppointments - Actual appointments
 * @param {number} doctorCount - Number of doctors
 * @param {number} workingDays - Working days in period (default: 22)
 * @param {number} appointmentsPerDay - Target appointments per doctor per day (default: 8)
 * @returns {number} Utilization rate percentage
 */
export function calculateUtilizationRate(
  actualAppointments, 
  doctorCount, 
  workingDays = 22, 
  appointmentsPerDay = 8
) {
  if (doctorCount === 0) {return 0;}
  
  const capacity = doctorCount * workingDays * appointmentsPerDay;
  const utilizationRate = (actualAppointments / capacity) * 100;
  
  return Math.min(Math.round(utilizationRate), 100);
}

/**
 * Parse available days string
 * @param {string} availableDays - Comma-separated days string
 * @returns {Array} Array of day names
 */
export function parseAvailableDays(availableDays) {
  if (!availableDays) {return [];}
  
  return availableDays
    .split(',')
    .map(day => day.trim())
    .filter(day => day.length > 0);
}

/**
 * Check if department is operational today
 * @param {Object} department - Department object with doctors
 * @returns {boolean} Is operational today
 */
export function isDepartmentOperationalToday(department) {
  const today = getCurrentDay();
  
  return department.doctors?.some(doctor => {
    if (!doctor.is_available) {return false;}
    if (!doctor.available_days) {return true;} // If no specific days, assume all days
    
    const availableDays = parseAvailableDays(doctor.available_days);
    return availableDays.includes(today);
  }) || false;
}

/**
 * Get department status color
 * @param {Object} department - Department object
 * @returns {string} Status color code
 */
export function getDepartmentStatusColor(department) {
  if (!department.is_active) {return '#6B7280';} // Gray for inactive
  if (department.available_doctors === 0) {return '#EF4444';} // Red for no available doctors
  if (department.available_doctors < 3) {return '#F59E0B';} // Amber for low availability
  return '#10B981'; // Green for good availability
}

/**
 * Sort departments by priority
 * @param {Array} departments - Array of departments
 * @returns {Array} Sorted departments
 */
export function sortDepartmentsByPriority(departments) {
  return departments.sort((a, b) => {
    // First priority: Active status
    if (a.is_active !== b.is_active) {
      return b.is_active ? 1 : -1;
    }
    
    // Second priority: Available doctors count
    if (a.available_doctors !== b.available_doctors) {
      return b.available_doctors - a.available_doctors;
    }
    
    // Third priority: Total doctors count
    if (a.doctor_count !== b.doctor_count) {
      return b.doctor_count - a.doctor_count;
    }
    
    // Finally, alphabetical order
    return a.name.localeCompare(b.name);
  });
}