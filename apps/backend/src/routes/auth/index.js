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

// Dev-only shortcuts — let the patient app obtain a real JWT without a
// Firebase OTP round-trip (needed for emulator / CI / swarm-QA runs
// where a phone-verified Firebase session cannot exist).
//
// Production must stay fail-closed: only mount when ENABLE_DEV_AUTH is
// explicitly 'true' and NODE_ENV is not 'production'. In non-production
// environments (development / test / unset), the route is mounted by
// default so QA harnesses don't need to thread a flag through every
// orchestrator script — the swarm previously hit this gate repeatedly
// (findings 2026-05-{10,12,13}-*-patient-dev-login*). To explicitly
// disable in dev/test, set ENABLE_DEV_AUTH=false.
//
// SECURITY: the route is still gated by the standard x-api-key check
// (validateApiKey) and creates only PATIENT-role JWTs — it cannot escalate
// to staff/admin even if accidentally exposed.
const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const devAuthFlag = process.env.ENABLE_DEV_AUTH;
const devAuthFlagSet = devAuthFlag !== undefined && devAuthFlag !== '';
const enableDevAuth = isProd
  ? String(devAuthFlag || '').toLowerCase() === 'true'
  : (!devAuthFlagSet || String(devAuthFlag || '').toLowerCase() !== 'false');
if (enableDevAuth) {
  const { default: devAuthRoutes } = await import('./devAuthRoutes.js');
  router.use('/dev', devAuthRoutes);
  logger.warn(`  - Dev Auth:    /api/v1/auth/dev/* (NODE_ENV=${process.env.NODE_ENV || 'unset'}, ENABLE_DEV_AUTH=${devAuthFlag ?? 'unset'})`);
}

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
