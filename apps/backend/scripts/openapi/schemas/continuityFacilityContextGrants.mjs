// apps/backend/scripts/openapi/schemas/continuityFacilityContextGrants.mjs
// Admin management of clinical-continuity facility-context capture grants
// (src/routes/admin/deviceRegistryRoutes.js, mounted at /api/v1/admin/devices),
// requiring INTEGRATION_ADMIN, ADMIN, or SUPER_ADMIN (requireManage/canManage).
// Gated behind clinicalContinuityFacilityEnrollmentEnabled(), which chains
// through the hardcoded-false CLINICAL_CONTINUITY_C_D14_APPROVED constant, so
// every operation here currently always responds 503
// CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE in this codebase.

const base = '/api/v1/admin/devices/continuity-facility-context';
const ALWAYS_503 =
  ' Currently always returns 503 CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE -- gated behind ' +
  'clinicalContinuityFacilityEnrollmentEnabled(), which chains through the hardcoded-false ' +
  'CLINICAL_CONTINUITY_C_D14_APPROVED flag that no deployment configuration can override.';

export const operations = {
  [`GET ${base}/grants`]: {
    summary: 'List clinical-continuity facility-context capture grants',
    description:
      'Read-only listing, restricted to INTEGRATION_ADMIN/ADMIN/SUPER_ADMIN callers, of a ' +
      "tenant's clinical-continuity facility-context capture grants -- device- or staff-plus-" +
      'device-bound authorizations to mint continuity facility contexts -- optionally filtered ' +
      'to one facility via `facility_id`, including each grant\'s revocation record when ' +
      'revoked.' + ALWAYS_503,
  },
  [`POST ${base}/enroll`]: {
    summary: 'Enroll a new facility-context capture grant',
    description:
      'Mutates (INTEGRATION_ADMIN/ADMIN/SUPER_ADMIN only): enrolls a new clinical-continuity ' +
      "facility-context capture grant for a tenant/facility. A device id and its Ed25519 public " +
      "key are required unconditionally; a named staff member is additionally required when " +
      "grant_purpose is 'capture_staff_facility' and forbidden for 'capture_fixed_device' -- it " +
      "is not an either/or between a staff grant and a device grant, every grant is device-" +
      'bound. Rejected unless the facility has an active continuity policy whose effective ' +
      'window covers the requested validity range. Returns 201 on success.' + ALWAYS_503,
    responseStatus: 201,
  },
  [`POST ${base}/revoke`]: {
    summary: 'Revoke a facility-context capture grant',
    description:
      'Mutates (INTEGRATION_ADMIN/ADMIN/SUPER_ADMIN only): revokes an existing clinical-' +
      'continuity facility-context capture grant, recording the revoking actor and a mandatory ' +
      'audited reason (non-empty, at most 500 characters, no control characters).' + ALWAYS_503,
  },
};
