// src/routes/index.js

import express from 'express';

// ✅ Route Imports
import uploadRoutes from './uploadRoutes.js';
import debugRoutes from './debugRoutes.js';
import userRoutes from './userRoutes.js';
import lookupRoutes from './lookupRoutes.js';
import firebaseAuthRoutes from './firebaseAuthRoutes.js';
import authRoutes from './authRoutes.js';
import departmentRoutes from './departmentRoutes.js';
import doctorRoutes from './doctorRoutes.js';
import appointmentRoutes from './appointmentRoutes.js';
import recordRoutes from './recordRoutes.js';
import investigationRoutes from './investigationRoutes.js';
import pharmacyRoutes from './pharmacyRoutes.js';
import feedbackRoutes from './feedbackRoutes.js';
import otpRoutes from './otpRoutes.js';
import versionRoutes from './versionRoutes.js';
import healthRoutes from './healthRoutes.js';
import sosRoutes from './sosRoutes.js';
import adminDepartmentRoutes from './adminDepartmentRoutes.js';
import adminDoctorRoutes from './adminDoctorRoutes.js';
import staffRoutes from './staffRoutes.js';
import swaggerRoutes from './swaggerRoutes.js';

// ✅ Role-Based Rate Limiters
import {
  patientRateLimiter,
  staffRateLimiter,
  adminRateLimiter,
  genericLimiter
} from '../middleware/rateLimitMiddleware.js';

const router = express.Router();

// ✅ Base Rate Limiting by Scope
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

// ✅ Mount API Versioned Routes
router.use('/api/v1/auth', firebaseAuthRoutes);
router.use('/api/v1', debugRoutes);
router.use('/api/v1/auth', authRoutes);
router.use('/api/v1/upload', uploadRoutes);
router.use('/api/v1/users', userRoutes);
router.use('/api/v1/lookup', lookupRoutes);
router.use('/api/v1/departments', departmentRoutes);
router.use('/api/v1/doctors', doctorRoutes);
router.use('/api/v1/appointments', appointmentRoutes);
router.use('/api/v1/records', recordRoutes);
router.use('/api/v1/investigations', investigationRoutes);
router.use('/api/v1/pharmacy-orders', pharmacyRoutes);
router.use('/api/v1/feedback', feedbackRoutes);
router.use('/api/v1/otp', otpRoutes);
router.use('/api/v1/version', versionRoutes);
router.use('/api/v1/health', healthRoutes);
router.use('/api/v1/sos', sosRoutes);
router.use('/api/v1/admin/departments', adminDepartmentRoutes);
router.use('/api/v1/admin/doctors', adminDoctorRoutes);
router.use('/api/v1/staff', staffRoutes);

// ✅ Swagger UI Route
router.use('/api-docs', swaggerRoutes);

// ✅ Generic fallback rate limiter for unmatched or public routes
router.use(genericLimiter);

// ✅ Fallback 404 Handler (No wildcard to preserve Swagger support)
router.use((req, res) => {
  console.warn(`⚠️  Unmatched Route: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'API endpoint not found' });
});

export default router;
