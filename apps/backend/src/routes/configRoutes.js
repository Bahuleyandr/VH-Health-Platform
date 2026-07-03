import express from 'express';
import { success } from '../utils/responseHelper.js';

const router = express.Router();

export function minPatientVersionCodeFromEnv(value = process.env.MIN_PATIENT_VERSION_CODE) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

// GET /api/v1/config
// Public, non-PHI patient app boot configuration.
router.get('/', (req, res) => {
  success(
    res,
    {
      min_patient_version_code: minPatientVersionCodeFromEnv()
    },
    'Patient app configuration retrieved'
  );
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
