// src/routes/auth/index.js - Main Authentication Router

import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import logger from '../../logging/logger.js';
import adminAuthRoutes from './adminAuthRoutes.js';
import adminOtpRoutes from './adminOtpRoutes.js';
import authRoutes from './authRoutes.js';
import firebaseAuthRoutes from './firebaseAuthRoutes.js';
import otpRoutes from './otpRoutes.js';
import staffAuthRoutes from './staffAuthRoutes.js';

const router = express.Router();

/*
 * Authentication Architecture:
 * 
 * 1. PATIENT AUTHENTICATION (Primary):
 *    - Frontend (mobile app) handles OTP via Firebase Auth
 *    - Frontend receives Firebase ID token
 *    - Backend verifies Firebase token at /firebase/firebase-login
 *    - Backend issues JWT for API access
 * 
 * 2. ADMIN AUTHENTICATION (Web Portal):
 *    - Username/password based authentication
 *    - Separate admin users table
 *    - Login at /admin/login
 *    - Password reset functionality included
 * 
 * 3. STAFF AUTHENTICATION (Staff Mobile App):
 *    - Employee ID + Password for initial device registration
 *    - PIN/Biometric for daily quick login
 *    - Device-based trust model
 *    - Location-aware for attendance
 * 
 * 4. DIRECT OTP (Secondary - Admin/Testing):
 *    - Backend stores OTP in database
 *    - No SMS sending (unless implemented later)
 *    - Used for admin override, testing, special cases
 * 
 * 5. JWT TOKENS:
 *    - All authenticated requests use JWT
 *    - Tokens can be refreshed at /refresh-token
 *    - Works regardless of initial auth method
 *    - Different claims for patients, staff, and admins
 */

// Mount sub-routes
router.use('/', authRoutes); // Core auth at /api/v1/auth/* (legacy/utility)
router.use('/firebase', firebaseAuthRoutes); // Firebase at /api/v1/auth/firebase/* (PATIENT LOGIN)
router.use('/otp', otpRoutes); // OTP at /api/v1/auth/otp/* (admin/testing)
router.use('/admin/otp', adminOtpRoutes); // Admin OTP at /api/v1/auth/admin/otp/*
router.use('/admin', adminAuthRoutes); // Admin auth at /api/v1/auth/admin/* (USERNAME/PASSWORD)
router.use('/staff', staffAuthRoutes); // Staff auth at /api/v1/auth/staff/* (EMPLOYEE ID + PIN)

// Apply RBAC wrapper to the entire auth module
const protectedRouter = wrapAutoRBAC(router, 'authenticationModule', {}, {
  requireUID: false,
  requirePhone: false,
  skipAudit: false
});

logger.info('✅ Authentication module loaded with consolidated routes');
logger.info('  - Core auth: /api/v1/auth/* (legacy/utility routes)');
logger.info('  - Firebase: /api/v1/auth/firebase/* (PRIMARY PATIENT AUTH)');
logger.info('  - OTP: /api/v1/auth/otp/* (admin/testing only)');
logger.info('  - Admin OTP: /api/v1/auth/admin/otp/* (monitoring/override)');
logger.info('  - Admin Auth: /api/v1/auth/admin/* (USERNAME/PASSWORD for web portal)');
logger.info('  - Staff Auth: /api/v1/auth/staff/* (EMPLOYEE + PIN for staff app)');

export default protectedRouter;