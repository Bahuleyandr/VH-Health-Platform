import 'role_config.dart';
import 'staff_role_contract.g.dart';

abstract final class WardIndentRoleContract {
  static const readRoleCodes = {
    'SUPER_ADMIN',
    'ADMIN',
    'DOCTOR',
    'DUTY_DOCTOR',
    'CONSULTANT',
    'SENIOR_DOCTOR',
    'JUNIOR_DOCTOR',
    'RESIDENT',
    'NURSING_STAFF',
    'NURSING_INCHARGE',
    'IP_STAFF_NURSE',
    'IP_INCHARGE',
    'ICU_NURSE',
    'ICU_INCHARGE',
    'ICU_STAFF',
    'ER_STAFF',
    'ADMISSION_OFFICER',
    'IPD_COUNSELLOR',
    'PHARMACY_STAFF',
    'PHARMACY_INCHARGE',
    'PHARMACIST',
    'STORES_PURCHASE_INCHARGE',
  };

  static const requestRoleCodes = {
    'SUPER_ADMIN',
    'ADMIN',
    'DOCTOR',
    'DUTY_DOCTOR',
    'CONSULTANT',
    'SENIOR_DOCTOR',
    'JUNIOR_DOCTOR',
    'RESIDENT',
    'NURSING_STAFF',
    'NURSING_INCHARGE',
    'IP_STAFF_NURSE',
    'IP_INCHARGE',
    'ICU_NURSE',
    'ICU_INCHARGE',
    'ICU_STAFF',
    'ER_STAFF',
    'ADMISSION_OFFICER',
    'IPD_COUNSELLOR',
    'PHARMACY_STAFF',
    'PHARMACY_INCHARGE',
    'PHARMACIST',
  };

  static const supplyRoleCodes = {
    'SUPER_ADMIN',
    'ADMIN',
    'PHARMACY_STAFF',
    'PHARMACY_INCHARGE',
    'PHARMACIST',
    'STORES_PURCHASE_INCHARGE',
  };

  static const controlledDispenseRoleCodes = {
    'SUPER_ADMIN',
    'ADMIN',
    'PHARMACY_STAFF',
    'PHARMACY_INCHARGE',
    'PHARMACIST',
  };

  static const substitutionDecisionRoleCodes = {
    'DOCTOR',
    'DUTY_DOCTOR',
    'CONSULTANT',
    'JUNIOR_DOCTOR',
    'RESIDENT',
  };

  static const wardReceiptRoleCodes = {
    'NURSING_STAFF',
    'NURSING_INCHARGE',
    'IP_STAFF_NURSE',
    'IP_INCHARGE',
    'ICU_NURSE',
    'ICU_INCHARGE',
    'ICU_STAFF',
    'ER_STAFF',
  };

  static const reconciliationRoleCodes = {
    'PHARMACY_INCHARGE',
    'NURSING_INCHARGE',
    'IP_INCHARGE',
    'ICU_INCHARGE',
  };

  static bool canRead({required String rawRole, required StaffRole role}) {
    return readRoleCodes.contains(canonicalRoleCode(rawRole, role));
  }

  static String canonicalRoleCode(String rawRole, StaffRole role) {
    final normalized = rawRole.trim().toUpperCase();
    if (canonicalStaffRoleCodes.contains(normalized)) return normalized;
    return role.value;
  }
}
