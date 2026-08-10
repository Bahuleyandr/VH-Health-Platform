// apps/backend/scripts/openapi/schemas/abdmAbhaRegistration.mjs
// ABHA linkage write on the ABDM patient surface
// (src/routes/abdm/abdmRoutes.js — patientRouter, mounted at /api/v1/abdm).
//
// Typed because this operation's request body is exactly what drifted: the
// patient app POSTed an ABDM *enrolment* payload ({mobile, name, yearOfBirth,
// gender, email}) at a *linkage* endpoint and every call 400'd, undetected,
// because nothing in the pipeline described the body. The client-path gate
// (scripts/ci/check-client-paths.mjs) matches method + path only, so a published
// request schema is the one mechanism in this repo that makes a body-shape
// mismatch reviewable.

import { envelope } from './_helpers.mjs';

export const schemas = {
  AbhaLinkRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['abha_number'],
    properties: {
      abha_number: {
        type: 'string',
        description:
          '14-digit ABHA number of an account the patient ALREADY HOLDS. Hyphens in the '
          + 'canonical 2-4-4-4 spelling are accepted and normalized to the canonical hyphenated '
          + 'form before storage; anything that is not 14 digits once hyphens are removed is '
          + 'rejected with INVALID_ABHA_FORMAT.',
        example: '12-3456-7890-1234',
      },
      abha_address: {
        type: 'string',
        nullable: true,
        description:
          'Optional ABHA address ("user@abdm"). Validated for shape only — the suffix differs '
          + 'between the production (@abdm) and sandbox (@sbx) environments — and lower-cased '
          + 'before storage. A malformed value is rejected with INVALID_ABHA_ADDRESS rather '
          + 'than stored.',
        example: 'patient@abdm',
      },
      patient_uid: {
        type: 'string',
        nullable: true,
        description:
          'Link on behalf of another patient. ADMIN and SUPER_ADMIN only; any other role '
          + 'supplying a uid other than its own is refused with 403. Omit for self-linkage — '
          + 'the target is then taken from the JWT.',
      },
    },
  },
  AbhaLinkResult: {
    type: 'object',
    additionalProperties: false,
    required: ['linked', 'abhaNumber', 'abhaAddress', 'verification_status', 'abha_verified_at'],
    properties: {
      linked: {
        type: 'boolean',
        description: 'Always true on a 200 — the response describes the linkage that now exists.',
      },
      abhaNumber: {
        type: 'string',
        nullable: true,
        description: 'The ABHA number now on file, normalized to canonical 2-4-4-4 spelling.',
      },
      abhaAddress: {
        type: 'string',
        nullable: true,
        description: 'The normalized ABHA address now on file, or null when none was supplied.',
      },
      verification_status: {
        type: 'string',
        enum: ['pending', 'verified'],
        description:
          'Verification state minted for the link (migration 653). `verified` only when the '
          + 'ABDM gateway confirmed the number during this call, or when re-linking the same '
          + 'number whose earlier verification is preserved; linking while ABDM is '
          + 'disabled, or under the audited ABDM_ABHA_ALLOW_UNVERIFIED override, mints '
          + '`pending`. A pending link displays to the patient but does not resolve in ABDM '
          + 'flows and does not block another patient from claiming (and verifying) the same '
          + 'number.',
      },
      abha_verified_at: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description: 'When the number was gateway-verified, or null for a pending link.',
      },
    },
  },
  AbhaLinkResultResponse: envelope('AbhaLinkResult'),
  AbhaVerifyLinkedRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      patient_uid: {
        type: 'string',
        nullable: true,
        description:
          'Verify on behalf of another patient. ADMIN and SUPER_ADMIN only; any other role '
          + 'supplying a uid other than its own is refused with 403. Omit for self — the '
          + 'target is then taken from the JWT.',
      },
    },
  },
};

export const operations = {
  'POST /api/v1/abdm/register-abha': {
    summary: 'Link an existing ABHA to a patient account',
    description:
      'Binds an ABHA (Ayushman Bharat Health Account) the patient ALREADY HOLDS to their VH '
      + 'Health record, and returns the resulting linkage in the same shape as '
      + '`GET /api/v1/abdm/my-abha`. Despite the path, this is a LINK and not an enrolment: '
      + "creating a new ABHA is an ABDM Aadhaar/mobile-OTP flow this platform does not "
      + 'implement, so a patient without an ABHA obtains one from the ABHA app or an enrolment '
      + 'centre first. By default a caller links only their own account; ADMIN and SUPER_ADMIN '
      + 'may pass `patient_uid` to link on behalf of a patient, and every other role supplying '
      + 'someone else\'s uid gets a 403. A VERIFIED link is unique within the tenant — a '
      + 'number already gateway-verified for another patient, in either the plain or the '
      + 'hyphenated spelling, is refused with 409 ABHA_ALREADY_LINKED; pending (unverified) '
      + 'claims by other patients do not block. Works while ABDM credentials are '
      + 'unconfigured (the linkage is recorded locally with `verification_status: pending`); '
      + 'once `ABDM_ENABLED` is set the number '
      + 'is first verified against the ABDM gateway (a success mints `verified`) and linkage '
      + 'FAILS CLOSED with 503 '
      + 'ABHA_VERIFICATION_FAILED if that verification cannot be completed, unless the audited '
      + '`ABDM_ABHA_ALLOW_UNVERIFIED` override is active (which mints `pending`). A pending '
      + 'link is promoted later via `POST /api/v1/abdm/my-abha/verify`. Re-linking the same '
      + 'already-verified number preserves its verified state and original verification time, '
      + 'including while ABDM is disabled. The write commits with '
      + 'an ABHA_LINKED clinical audit row in one transaction and is recorded to the HIPAA '
      + 'PHI access log.',
    request: 'AbhaLinkRequest',
    response: 'AbhaLinkResultResponse',
  },
  'POST /api/v1/abdm/my-abha/verify': {
    summary: 'Verify the linked ABHA number with the ABDM gateway',
    description:
      'Verifies the ABHA number ALREADY LINKED (pending) on the account against the ABDM '
      + 'gateway and promotes the link to `verified` (migration 653). By default the caller '
      + 'verifies their own link; ADMIN and SUPER_ADMIN may pass `patient_uid` to verify on '
      + "behalf of a patient, and every other role supplying someone else's uid gets a 403. "
      + 'Requires ABDM to be enabled — while `ABDM_ENABLED` is unset the endpoint fails closed '
      + 'with 503 ABDM_NOT_ENABLED and there is no override: a pending link can only become '
      + 'verified through a real gateway check. 404 ABHA_NOT_LINKED when no number is on '
      + 'file; an already-verified link is an idempotent 200 no-op. If another patient '
      + 'verified the same canonical number first, promotion is refused with 409 '
      + 'ABHA_ALREADY_LINKED and the link stays pending; a gateway failure or unknown number '
      + 'is 400 ABHA_VERIFICATION_FAILED, also leaving the link pending. On success the '
      + 'promotion and an ABHA_VERIFIED clinical audit row commit in one transaction, and the '
      + 'write is recorded to the HIPAA PHI access log.',
    request: 'AbhaVerifyLinkedRequest',
    response: 'AbhaLinkResultResponse',
  },
};
