module.exports = {
  ADMIN: 'Admin',
  PATIENT: 'Patient',
  NURSING_STAFF: 'Nursing Staff',
  PHARMACY_STAFF: 'Pharmacy Staff',
  LAB_STAFF: 'Lab Staff',
  DOCTOR: 'Doctor',
  GENERAL_STAFF: 'General Staff',
  HR_STAFF: 'HR Staff',
};

module.exports.hasRole = (user, allowedRoles) => {
  if (!user || !user.role) return false;
  return allowedRoles.includes(user.role);
};
