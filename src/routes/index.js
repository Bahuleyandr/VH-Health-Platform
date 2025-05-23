// src/routes/index.js

import express from 'express';

// ✅ Route Imports
import upload from './uploadRoutes.js';
import debug from './debugRoutes.js';
import users from './userRoutes.js';
import lookup from './lookupRoutes.js';
import auth from './authRoutes.js';
import firebaseAuth from './firebaseAuthRoutes.js';
import departments from './departmentRoutes.js';
import doctors from './doctorRoutes.js';
import appointments from './appointmentRoutes.js';
import healthRecords from './recordRoutes.js';
import investigations from './investigationRoutes.js';
import pharmacy from './pharmacyRoutes.js';
import feedback from './feedbackRoutes.js';
import otp from './otpRoutes.js';
import version from './versionRoutes.js';
import health from './healthRoutes.js';
import sos from './sosRoutes.js';
import adminDepartmentRoutes from './adminDepartmentRoutes.js';
import adminDoctorRoutes from './adminDoctorRoutes.js';
import staffRoutes from './staffRoutes.js';
import swaggerRoutes from './swaggerRoutes.js';
import doctors from './doctorRoutes.js';
import departments from './departmentRoutes.js';

import {
  patientRateLimiter,
  staffRateLimiter,
  adminRateLimiter,
  genericLimiter
} from '../middleware/rateLimitMiddleware.js';

const router = express.Router();

// ✅ Rate Limiting by Role
router.use('/api/v1/auth', patientRateLimiter);
router.use('/api/v1/users', patientRateLimiter);
router.use('/api/v1/appointments', patientRateLimiter);
router.use('/api/v1/records', patientRateLimiter);
router.use('/api/v1/investigations', patientRateLimiter);
router.use('/api/v1/pharmacy-orders', patientRateLimiter);
router.use('/api/v1/feedback', patientRateLimiter);
router.use('/api/v1/otp', patientRateLimiter);
router.use('/api/v1/sos', patientRateLimiter);

router.use('/api/v1/staff', staffRateLimiter);
router.use('/api/v1/admin', adminRateLimiter);

// ✅ Mount All Routes
router.use('/api/v1/auth', firebaseAuth);
router.use('/api/v1/auth', auth);
router.use('/api/v1', debug);
router.use('/api/v1/upload', upload);
router.use('/api/v1/users', users);
router.use('/api/v1/lookup', lookup);
router.use('/api/v1/departments', departments);
router.use('/api/v1/doctors', doctors);
router.use('/api/v1/appointments', appointments);
router.use('/api/v1/records', healthRecords);
router.use('/api/v1/investigations', investigations);
router.use('/api/v1/pharmacy-orders', pharmacy);
router.use('/api/v1/feedback', feedback);
router.use('/api/v1/otp', otp);
router.use('/api/v1/version', version);
router.use('/api/v1/health', health);
router.use('/api/v1/sos', sos);
router.use('/api/v1/admin/departments', adminDepartmentRoutes);
router.use('/api/v1/admin/doctors', adminDoctorRoutes);
router.use('/api/v1/staff', staffRoutes);

// ✅ Swagger UI
router.use('/api-docs', swaggerRoutes);

// ✅ Generic fallback
router.use(genericLimiter);
router.use((req, res) => {
  console.warn(`⚠️  Unmatched Route: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'API endpoint not found' });
});

export default {
  auth,
  otp,
  lookup,
  version,
  health,
  users,
  appointments,
  healthRecords,
  investigations,
  pharmacy,
  feedback,
  sos,
  upload,
  doctors,
  departments
};
