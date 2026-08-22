// src/config/specialtyDepartmentPolicy.js
//
// THE single declaration of the department-gated specialty modules: which
// specialty keys exist, which departments admit them, and which staff-app
// feature tile each one controls. Both consumers derive from this file:
//
//   - specialtyDepartmentMiddleware.js (server gate — report/enforce 403s)
//   - scripts/generate-staff-role-contract.mjs (client tile filter — emits
//     the alias sets into the generated Dart contract)
//
// Keeping them in ONE structure means a module cannot exist server-side
// without its client tile filter or vice versa (2026-08-22 design-panel
// finding: the two were previously parallel hand-synced maps, and nothing
// failed CI when they diverged).
//
// This module must stay DEPENDENCY-FREE: the contract generator runs in the
// Flutter CI job where backend node_modules (notably @prisma/client) are not
// installed, so nothing here may import — directly or transitively — from
// src/lib, src/logging, src/utils or any package.

// Alias sets are matched against BOTH the doctor-record department (normalized
// via doctors.department_id -> departments.name — the reliable path) and the
// free-text staff.department / doctors.department columns. Everything is
// compared lowercased with punctuation collapsed (normalizeDepartment below).
//
// Transplant has no department of its own; the owner-approved interim mapping
// is the renal/surgical services that run the programme.
export const SPECIALTY_DEPARTMENT_MODULES = {
  dental: {
    aliases: ['dentistry', 'dental'],
    featureId: 'dental_charting',
  },
  oncology: {
    aliases: ['oncology', 'medical oncology', 'clinical oncology'],
    featureId: 'oncology',
  },
  radiation_oncology: {
    aliases: ['oncology', 'radiation oncology', 'radiotherapy'],
    featureId: 'radiation_oncology',
  },
  ophthalmology: {
    aliases: ['ophthalmology'],
    featureId: 'ophthalmology',
  },
  transplant: {
    aliases: ['nephrology', 'general surgery', 'urology', 'transplant'],
    featureId: 'transplant_program',
  },
};

// Derived views kept for the existing consumer shapes.
export const SPECIALTY_DEPARTMENT_ALIASES = Object.fromEntries(
  Object.entries(SPECIALTY_DEPARTMENT_MODULES).map(([key, mod]) => [key, mod.aliases]),
);

export const SPECIALTY_FEATURE_KEYS = Object.fromEntries(
  Object.entries(SPECIALTY_DEPARTMENT_MODULES).map(([key, mod]) => [mod.featureId, key]),
);

// Leadership/administrative bypass: these roles supervise every specialty.
// Without it, enforce mode would lock the CMO out of every specialty module.
export const SPECIALTY_GATE_BYPASS_ROLES = new Set([
  'SUPER_ADMIN',
  'ADMIN',
  'CMO',
  'CNO',
  'MEDICAL_SUPERINTENDENT',
]);

export function specialtyGateMode(env = process.env) {
  const raw = String(env.SPECIALTY_DEPARTMENT_GATE_MODE || 'report').trim().toLowerCase();
  return ['off', 'report', 'enforce'].includes(raw) ? raw : 'report';
}

export function normalizeDepartment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function departmentsMatchSpecialty(departments, specialtyKey) {
  const aliases = SPECIALTY_DEPARTMENT_ALIASES[specialtyKey] || [];
  const normalizedAliases = new Set(aliases.map(normalizeDepartment));
  return [...departments].some((dept) => normalizedAliases.has(dept));
}
