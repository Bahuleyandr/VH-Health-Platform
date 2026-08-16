import { envelope } from './_helpers.mjs';

export const schemas = {
  PatientAccountDeletionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['firebaseIdToken'],
    properties: {
      firebaseIdToken: {
        type: 'string',
        minLength: 10,
        maxLength: 4096,
        description: 'Fresh Firebase ID token from an OTP re-authentication challenge.'
      },
      reason: {
        type: 'string',
        maxLength: 160,
        description: 'Optional operator-facing deletion reason; defaults to patient_self_service.'
      }
    }
  },

  PatientAccountDeletionResult: {
    type: 'object',
    additionalProperties: false,
    required: ['uid', 'deleted', 'clinicalRecordsRetained'],
    properties: {
      uid: { type: 'string', format: 'uuid' },
      deleted: { type: 'boolean', example: true },
      clinicalRecordsRetained: { type: 'boolean', example: true }
    }
  },

  PatientAccountDeletionResponse: envelope('PatientAccountDeletionResult'),

  FamilyMemberPromoteRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['relationship', 'consent_confirmed'],
    properties: {
      relationship: {
        type: 'string',
        enum: [
          'parent', 'mother', 'father', 'legal_guardian', 'grandparent',
          'sibling', 'spouse', 'other',
        ],
        description: 'Declared guardian→dependent relationship (part of the consent declaration).'
      },
      consent_confirmed: {
        type: 'boolean',
        description: 'Explicit guardian consent declaration. Must be true — recorded as link_consent_method=guardian_declaration and audited.'
      },
      birthday: {
        type: 'string',
        format: 'date',
        description: 'Dependent date of birth; required when the contact row carries none. The dependent must be a minor (<18y).'
      },
      gender: { type: 'string', enum: ['MALE', 'FEMALE', 'OTHER'] }
    }
  },

  FamilyMemberPromoteResult: {
    type: 'object',
    additionalProperties: false,
    required: ['dependent', 'family_member_id', 'created_identity', 'already_linked'],
    properties: {
      dependent: {
        type: 'object',
        additionalProperties: true,
        description: 'The linked dependent (dependents-roster shape: id, uid, name, masked phone, birthday, gender, is_minor, guardian_relationship, linked_at).'
      },
      family_member_id: { type: 'integer' },
      created_identity: {
        type: 'boolean',
        description: 'True when a new minor patient identity was minted (synthetic DEPEND- phone); false when an existing minor account was linked by phone.'
      },
      already_linked: { type: 'boolean' }
    }
  },

  FamilyMemberPromoteResponse: envelope('FamilyMemberPromoteResult')
};

export const operations = {
  'DELETE /api/v1/users/me/account': {
    request: 'PatientAccountDeletionRequest',
    response: 'PatientAccountDeletionResponse'
  },
  'POST /api/v1/users/family-members/{id}/promote': {
    request: 'FamilyMemberPromoteRequest',
    response: 'FamilyMemberPromoteResponse',
    description: 'Promote a family-member contact into a linked dependent: mints (or links by phone) a minor patient identity with users.guardian_user_id set — the same guardian→minor link the X-Acting-As-Uid hop and booking-on-behalf validate. Requires an explicit guardian consent declaration; idempotent for an already-promoted contact (200 instead of 201).'
  }
};
