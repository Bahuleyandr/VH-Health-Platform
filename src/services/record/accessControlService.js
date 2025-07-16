// src/services/record/accessControlService.js
import { PRIVACY_LEVELS } from '../../config/recordConfig.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { 
  ADMIN, PATIENT, NURSING_STAFF, PHARMACY_STAFF, 
  LAB_STAFF, DOCTOR, GENERAL_STAFF 
} from '../../utils/roles.js';

export function checkDataAccess(userRole, patientData, recordData) {
  const privacyLevel = recordData?.privacy_level || 0;
  
  switch (userRole) {
    case ADMIN:
      return true; // Full access
    case DOCTOR:
      return privacyLevel <= PRIVACY_LEVELS.CONFIDENTIAL; // No genetic/highly sensitive
    case NURSING_STAFF:
      return privacyLevel <= PRIVACY_LEVELS.RESTRICTED; // Basic medical access
    case LAB_STAFF:
      return recordData?.record_type === 'LAB_RESULT'; // Only lab results
    case PHARMACY_STAFF:
      return recordData?.record_type === 'PRESCRIPTION'; // Only prescriptions
    case PATIENT:
      return patientData?.uid === recordData?.patient_uid || 
         normalizePhone(patientData?.phone) === normalizePhone(recordData?.patient_phone);
    default:
      return false;
  }
}

export function filterRecordsByAccess(records, userRole, patientData) {
  return records.filter(record => 
    checkDataAccess(userRole, patientData, record)
  );
}

export function getPrivacyFilterForRole(userRole) {
  switch (userRole) {
    case ADMIN:
      return ''; // No filter
    case DOCTOR:
      return ` AND privacy_level <= ${PRIVACY_LEVELS.CONFIDENTIAL}`;
    case NURSING_STAFF:
      return ` AND privacy_level <= ${PRIVACY_LEVELS.RESTRICTED}`;
    case LAB_STAFF:
      return " AND record_type = 'LAB_RESULT'";
    case PHARMACY_STAFF:
      return " AND record_type = 'PRESCRIPTION'";
    default:
      return ' AND 1=0'; // No access
  }
}

export function canCreateRecord(userRole, patientPhone, userPhone) {
  if (userRole === PATIENT) {
    return normalizePhone(userPhone) === normalizePhone(patientPhone);
  }
  return [DOCTOR, NURSING_STAFF, ADMIN].includes(userRole);
}

export function canUpdateRecord(userRole, recordDoctorId, userId) {
  if (userRole === ADMIN) {return true;}
  if (userRole === DOCTOR && recordDoctorId === userId) {return true;}
  return false;
}