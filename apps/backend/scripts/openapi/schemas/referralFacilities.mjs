// apps/backend/scripts/openapi/schemas/referralFacilities.mjs
// Destination facility master for external referrals (migration 680):
// tenant-scoped facility CRUD under /api/v1/referrals/facilities plus the
// structured destination linkage mutation on a referral.
import { envelope } from './_helpers.mjs';

const FACILITY_TYPES = ['hospital', 'clinic', 'diagnostic', 'specialty_center', 'other'];

export const schemas = {
  ReferralFacility: {
    type: 'object',
    required: ['id', 'name', 'facilityType', 'active'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string', maxLength: 200 },
      facilityType: { type: 'string', enum: FACILITY_TYPES },
      specialties: {
        type: 'array',
        items: { type: 'string', maxLength: 120 },
        description: 'Free-form specialty tags used to filter the facility master.',
      },
      addressLine1: { type: 'string', maxLength: 300, nullable: true },
      addressLine2: { type: 'string', maxLength: 300, nullable: true },
      city: { type: 'string', maxLength: 120, nullable: true },
      state: { type: 'string', maxLength: 120, nullable: true },
      pincode: { type: 'string', pattern: '^[0-9]{6}$', nullable: true },
      phone: { type: 'string', maxLength: 20, nullable: true },
      email: { type: 'string', format: 'email', nullable: true },
      contactPerson: { type: 'string', maxLength: 120, nullable: true },
      notes: { type: 'string', maxLength: 2000, nullable: true },
      active: {
        type: 'boolean',
        description: 'Soft-delete flag: inactive facilities cannot receive new referrals but keep their historical linkage.',
      },
      createdBy: { type: 'string', format: 'uuid', nullable: true },
      updatedBy: { type: 'string', format: 'uuid', nullable: true },
      createdAt: { type: 'string', format: 'date-time', nullable: true },
      updatedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  ReferralFacilityListPayload: {
    type: 'object',
    required: ['facilities', 'count'],
    properties: {
      facilities: { type: 'array', items: { $ref: '#/components/schemas/ReferralFacility' } },
      count: { type: 'integer' },
    },
  },

  ReferralFacilityWriteRequest: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 200 },
      facilityType: { type: 'string', enum: FACILITY_TYPES },
      specialties: { type: 'array', items: { type: 'string', maxLength: 120 } },
      addressLine1: { type: 'string', maxLength: 300, nullable: true },
      addressLine2: { type: 'string', maxLength: 300, nullable: true },
      city: { type: 'string', maxLength: 120, nullable: true },
      state: { type: 'string', maxLength: 120, nullable: true },
      pincode: { type: 'string', pattern: '^[0-9]{6}$', nullable: true },
      phone: { type: 'string', maxLength: 20, nullable: true },
      email: { type: 'string', format: 'email', nullable: true },
      contactPerson: { type: 'string', maxLength: 120, nullable: true },
      notes: { type: 'string', maxLength: 2000, nullable: true },
    },
  },

  ReferralFacilityActiveRequest: {
    type: 'object',
    required: ['active'],
    properties: {
      active: { type: 'boolean' },
    },
  },

  ReferralDestinationFacilityRequest: {
    type: 'object',
    required: ['destination_facility_id'],
    properties: {
      destination_facility_id: { type: 'integer', minimum: 1 },
      reason: { type: 'string', maxLength: 2000, nullable: true },
      override_reason: {
        type: 'string',
        maxLength: 2000,
        nullable: true,
        description: 'Required when an admin or covering doctor (not the originator) changes the destination.',
      },
    },
  },

  ReferralFacilityListResponse: envelope('ReferralFacilityListPayload'),
  ReferralFacilityResponse: envelope('ReferralFacility'),
};

export const operations = {
  'GET /api/v1/referrals/facilities': {
    description:
      'Lists the tenant\'s external referral destination facility master (active facilities by default; admins may pass include_inactive=true). Supports q (name/city/specialty substring) and facility_type filters. Clinical staff read access — this feeds the destination picker on external referral creation.',
    response: 'ReferralFacilityListResponse',
  },
  'POST /api/v1/referrals/facilities': {
    description:
      'Creates a destination facility in the tenant\'s referral facility master. ADMIN or SUPER_ADMIN only. Name is unique per tenant and city (case-insensitive).',
    request: 'ReferralFacilityWriteRequest',
    response: 'ReferralFacilityResponse',
  },
  'GET /api/v1/referrals/facilities/{facilityId}': {
    description: 'Fetches one destination facility from the tenant\'s referral facility master.',
    response: 'ReferralFacilityResponse',
  },
  'PUT /api/v1/referrals/facilities/{facilityId}': {
    description:
      'Updates a destination facility; omitted fields keep their current values. ADMIN or SUPER_ADMIN only.',
    request: 'ReferralFacilityWriteRequest',
    response: 'ReferralFacilityResponse',
  },
  'PUT /api/v1/referrals/facilities/{facilityId}/active': {
    description:
      'Activates or deactivates a destination facility (soft delete). An inactive facility cannot be linked to new external referrals; historical referrals keep their linkage. ADMIN or SUPER_ADMIN only.',
    request: 'ReferralFacilityActiveRequest',
    response: 'ReferralFacilityResponse',
  },
  'PUT /api/v1/referrals/{id}/destination-facility': {
    description:
      'Sets or changes the structured destination facility of an EXTERNAL referral. The facility must belong to the tenant and be active. Originator doctor, or admin / covering doctor with a recorded override_reason; every change lands as a referral.destination_facility_changed transition event with canonical timeline and audit evidence.',
    request: 'ReferralDestinationFacilityRequest',
  },
};
