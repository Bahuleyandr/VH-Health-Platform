// apps/backend/scripts/openapi/schemas/abdm.mjs
// ABDM (Ayushman Bharat Digital Mission) patient-facing surface
// (src/routes/abdm/abdmRoutes.js — patientRouter, mounted at /api/v1/abdm).
//
// Scoped to the self-service ABHA linkage read added for audit F12. The rest of
// the ABDM surface (registration, gateway verification, consent management, the
// staff/admin lookups) is not typed here yet.

import { envelope } from './_helpers.mjs';

export const schemas = {
  AbhaLinkage: {
    type: 'object',
    additionalProperties: false,
    required: ['linked', 'abhaNumber', 'abhaAddress'],
    properties: {
      linked: {
        type: 'boolean',
        description:
          'True when the caller has an ABHA number or ABHA address on file. This is the '
          + 'authoritative flag — a patient may be linked by address alone, so do not infer '
          + 'linkage from `abhaNumber` being non-null.',
      },
      abhaNumber: {
        type: 'string',
        nullable: true,
        description: '14-digit ABHA number, or null when not linked.',
      },
      abhaAddress: {
        type: 'string',
        nullable: true,
        description: 'ABHA address (user@abdm), or null when not linked.',
      },
    },
  },
  AbhaLinkageResponse: envelope('AbhaLinkage'),
};

export const operations = {
  'GET /api/v1/abdm/my-abha': {
    summary: "The calling patient's own ABHA linkage state",
    description:
      'Returns whether the authenticated caller already has an ABHA (Ayushman Bharat Health '
      + 'Account) linked to their account, and the linkage details when they do. Identity is '
      + 'taken from the JWT and there is no lookup parameter, so this endpoint cannot disclose '
      + "another patient's linkage; callers wanting someone else's record use the staff/admin "
      + '`GET /api/v1/abdm/patient-by-abha/{abhaNumber}` lookup instead, which refuses the '
      + 'PATIENT role. A patient with no ABHA yet is an honest 200 with `linked: false` and null '
      + 'details rather than a 404 — 404 is reserved for "no active patient record exists for '
      + 'this caller in this tenant". Reads only local linkage columns and never calls the ABDM '
      + 'gateway, so unlike the gateway-backed ABDM routes it keeps working (rather than '
      + 'returning 503) while ABDM credentials are unconfigured. Access is recorded to the HIPAA '
      + 'PHI access log.',
    response: 'AbhaLinkageResponse',
  },
};
