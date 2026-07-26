const PHYSICIAN_ROLES = new Set([
  'DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
  'DUTY_DOCTOR',
  'SENIOR_DOCTOR',
]);

export function isInpatientPendingResultPhysicianRole(role) {
  return PHYSICIAN_ROLES.has(String(role || '').trim().toUpperCase());
}

export default {
  isInpatientPendingResultPhysicianRole,
};
