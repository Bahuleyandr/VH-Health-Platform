import express from 'express';
import { success } from '../utils/responseHelper.js';

const router = express.Router();

// GET /api/v1/config/campus-locations
// Returns campus geofence coordinates for staff attendance
router.get('/campus-locations', (req, res) => {
  // These could be stored in DB or env vars in the future
  const campusConfig = {
    campusLat: parseFloat(process.env.CAMPUS_LATITUDE || '13.02936'),
    campusLng: parseFloat(process.env.CAMPUS_LONGITUDE || '80.24409'),
    campusRadius: parseFloat(process.env.CAMPUS_RADIUS_METERS || '200'),
    hospitalName: process.env.HOSPITAL_NAME || 'Venkataeswara Hospitals',
    campusAddress: process.env.CAMPUS_ADDRESS || 'Nandanam, Chennai',
  };
  success(res, campusConfig, 'Campus configuration retrieved');
});

export default router;
