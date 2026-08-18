import express from 'express';
import { patientMinimumVersionPolicyFromEnv } from '../services/patientMinimumVersionPolicy.js';
import { resolveTenantForRequest } from '../services/tenant/tenantService.js';
import { success } from '../utils/responseHelper.js';

export { patientMinimumVersionPolicyFromEnv } from '../services/patientMinimumVersionPolicy.js';

const router = express.Router();

const PATIENT_OUTAGE_LOCALES = Object.freeze(['en', 'hi', 'ta', 'te', 'ml']);
const PATIENT_OUTAGE_KEYS = Object.freeze(['revision', 'messages', 'facility_contact_number']);
const PATIENT_OUTAGE_MAX_CONFIG_BYTES = 16 * 1024;
const PATIENT_OUTAGE_MAX_MESSAGE_LENGTH = 2000;
const PATIENT_OUTAGE_CONTACT_PATTERN = /^\+?[0-9][0-9 ()-]{2,63}$/;
const FACILITY_CONTACT_TOKEN = '[facility contact number]';

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

export function patientOutageCommunicationFromEnv(
  value = process.env.PATIENT_OUTAGE_COMMUNICATION_JSON
) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (Buffer.byteLength(value, 'utf8') > PATIENT_OUTAGE_MAX_CONFIG_BYTES) return null;

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!hasExactKeys(parsed, PATIENT_OUTAGE_KEYS)) return null;
  if (!Number.isSafeInteger(parsed.revision) || parsed.revision <= 0) return null;
  if (!hasExactKeys(parsed.messages, PATIENT_OUTAGE_LOCALES)) return null;

  const messages = {};
  for (const locale of PATIENT_OUTAGE_LOCALES) {
    const message = parsed.messages[locale];
    if (
      typeof message !== 'string' ||
      message.trim() !== message ||
      message.length === 0 ||
      message.length > PATIENT_OUTAGE_MAX_MESSAGE_LENGTH ||
      message.split(FACILITY_CONTACT_TOKEN).length !== 2
    ) {
      return null;
    }
    messages[locale] = message;
  }

  const contact = parsed.facility_contact_number;
  if (
    typeof contact !== 'string' ||
    contact.trim() !== contact ||
    !PATIENT_OUTAGE_CONTACT_PATTERN.test(contact)
  ) {
    return null;
  }

  return {
    revision: parsed.revision,
    messages,
    facility_contact_number: contact
  };
}

export function minPatientVersionCodeFromEnv(value = process.env.MIN_PATIENT_VERSION_CODE) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

// Staff hard-upgrade gate. Same fail-safe coercion as the patient projection:
// anything unusable reads as 0 = gate disabled. Unlike the patient gate there
// is no signed-policy envelope for staff — the staff client implements the
// unsigned legacy comparison (and fails open on an unusable /config) from its
// first gated build, so a bare code is not a bricking configuration.
export function minStaffVersionCodeFromEnv(value = process.env.MIN_STAFF_VERSION_CODE) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

// GET /api/v1/config
// Public, non-PHI app boot configuration (patient + staff minimum versions).
router.get('/', async (req, res, next) => {
  try {
    const expectedTenantId = req.tenantId ?? await resolveTenantForRequest(req);
    const outageCommunication = patientOutageCommunicationFromEnv();
    const minimumVersionPolicy = patientMinimumVersionPolicyFromEnv(
      undefined,
      expectedTenantId
    );
    const data = {
      min_patient_version_code:
        minimumVersionPolicy?.policy.min_patient_version_code
        ?? minPatientVersionCodeFromEnv(),
      min_staff_version_code: minStaffVersionCodeFromEnv()
    };
    if (minimumVersionPolicy !== null) {
      data.minimum_version_policy = minimumVersionPolicy;
    }
    if (outageCommunication !== null) {
      data.outage_communication = outageCommunication;
    }
    success(res, data, 'Patient app configuration retrieved');
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/config/campus-locations
// Returns campus geofence coordinates for staff attendance
router.get('/campus-locations', (req, res) => {
  // These could be stored in DB or env vars in the future
  const campusConfig = {
    campusLat: parseFloat(process.env.CAMPUS_LATITUDE || '13.02936'),
    campusLng: parseFloat(process.env.CAMPUS_LONGITUDE || '80.24409'),
    campusRadius: parseFloat(process.env.CAMPUS_RADIUS_METERS || '200'),
    hospitalName: process.env.HOSPITAL_NAME || 'Venkataeswara Hospitals',
    campusAddress: process.env.CAMPUS_ADDRESS || 'Nandanam, Chennai'
  };
  success(res, campusConfig, 'Campus configuration retrieved');
});

export default router;
