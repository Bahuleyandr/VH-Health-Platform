// src/app.js
import { initializeSourceMaps } from './config/sourceMapConfig.js';

// Initialize source maps before anything else
initializeSourceMaps();

import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import swaggerUi from 'swagger-ui-express';

// Logging and middleware imports
import logger from './logging/logger.js';
import { attachUserContext } from './middleware/attachUserContext.js';
import corsMiddleware, { corsErrorHandler } from './middleware/corsMiddleware.js';
import { errorHandlerMiddleware } from './middleware/errorHandlerMiddleware.js';
import jwtAuth from './middleware/jwtMiddleware.js';
import { phiAccessLogger } from './middleware/phiAccessMiddleware.js';
import { requireRole } from './middleware/rbacMiddleware.js';
import loggingMiddleware from './middleware/loggingMiddleware.js';
import requestIdMiddleware from './middleware/requestIdMiddleware.js';
import { normalizeIdentityFields } from './middleware/normalizeIdentityFields.js';
import { auditLogMiddleware } from './middleware/auditLog.js';
import { patientRateLimiter, genericLimiter, adminRateLimiter, dataExportRateLimiter, dashboardRateLimiter } from './middleware/rateLimitMiddleware.js';
import validateApiKey from './middleware/validateApiKey.js';
import apiVersionMiddleware from './middleware/apiVersionMiddleware.js';
import { selfHealingMiddleware } from './middleware/selfHealingMiddleware.js';
import { adminIpAllowlist } from './middleware/ipAllowlistMiddleware.js';
import { prometheusMiddleware } from './middleware/prometheusMiddleware.js';

// ====================================
// ROUTE IMPORTS - Organized by category
// ====================================

// Public / mixed modules
import appointmentRoutes from './routes/appointment/index.js';
import departmentRoutes from './routes/department/index.js';
import deviceRoutes from './routes/deviceRoutes.js';
import doctorRoutes from './routes/doctor/index.js';
import healthRoutes from './routes/health/index.js';
import routes from './routes/index.js';
import infrastructureRoutes from './routes/infrastructure/index.js';
import internalRoutes from './routes/internalRoutes.js';
import deliveryRoutes from './routes/delivery/index.js';
import investigationRoutes from './routes/investigation/index.js';
import notificationRoutes from './routes/notification/index.js';
import pharmacyRoutes from './routes/pharmacy/index.js';
import prescriptionRoutes from './routes/prescription/index.js';
import recordRoutes from './routes/record/index.js';
import searchRoutes from './routes/searchRoutes.js';
import staffRoutes from './routes/staff/index.js';
import userRoutes from './routes/user/index.js';
import { bedRouter, wardRouter } from './routes/bed/bedRoutes.js';
import bedManagementRoutes from './routes/bed/bedManagementRoutes.js';

// FHIR interoperability
import fhirRoutes from './routes/fhir/fhirRoutes.js';

// Clinical Document Export & Import
import documentRoutes from './routes/documents/documentRoutes.js';

// HL7v2 messaging
import hl7Routes from './routes/hl7/hl7Routes.js';

// Admin (centralized under /api/v1/admin)
import adminDashboardRoutes from './routes/admin/index.js';

// System settings and logs (admin portal: /api/v1/system/* and /api/v1/logs/*)
import systemRoutes from './routes/system/index.js';
import logRoutes from './routes/logs/index.js';

// Patient dashboard (API key only, no JWT)
import dashboardRoutes from './routes/dashboard/index.js';

// Config routes (API key only, no JWT)
import configRoutes from './routes/configRoutes.js';

// GDPR Data Export + Erasure
import dataExportRoutes from './routes/dataExportRoutes.js';
import gdprRoutes from './routes/gdprRoutes.js';

// HIPAA Consent Management
import consentRoutes from './routes/consentRoutes.js';

// Session Management (view/revoke active sessions)
import sessionRoutes from './routes/sessionRoutes.js';

// Admin 2FA (TOTP)
import totpRoutes from './routes/auth/totpRoutes.js';

// Compliance (Breach Notification + Audit Search)
import breachRoutes from './routes/compliance/breachRoutes.js';
import auditSearchRoutes from './routes/compliance/auditSearchRoutes.js';

// ABDM (Ayushman Bharat Digital Mission) Integration
import { callbackRouter as abdmCallbackRoutes, patientRouter as abdmPatientRoutes } from './routes/abdm/abdmRoutes.js';

// Billing & Invoicing
import billingRoutes from './routes/billing/billingRoutes.js';

// Quality & Infection Control
import qualityRoutes from './routes/quality/qualityRoutes.js';

// Referral Management
import referralRoutes from './routes/referral/referralRoutes.js';

// Department modules: Radiology, Dietary, Operating Theatre, Blood Bank
import radiologyRoutes from './routes/radiology/radiologyRoutes.js';
import dietaryRoutes from './routes/dietary/dietaryRoutes.js';
import theatreRoutes from './routes/theatre/theatreRoutes.js';
import bloodBankRoutes from './routes/bloodbank/bloodBankRoutes.js';

// Inter-staff messaging
import messagingRoutes from './routes/messaging/messagingRoutes.js';

// Patient reminders (medication)
import reminderRoutes from './routes/reminders/index.js';
import stepsRoutes from './routes/steps/stepsRoutes.js';
import stepRewardsRoutes from './routes/steps/stepRewardsRoutes.js';

// Clinical workflows (MAR, NEWS2, Handover)
import clinicalRoutes from './routes/clinical/clinicalRoutes.js';

// EMR — Clinical Documentation (SOAP, Progress, Procedure, Discharge, Timeline)
import clinicalNotesRoutes from './routes/emr/clinicalNotesRoutes.js';

// EMR — ADT (Admission/Discharge/Transfer)
import admissionRoutes from './routes/emr/admissionRoutes.js';

// EMR — CPOE (Order Entry) and Vitals Charting
import orderRoutes from './routes/emr/orderRoutes.js';
import vitalsRoutes from './routes/emr/vitalsRoutes.js';

// EMR — Clinical Decision Support (CDS) Engine
import cdsRoutes from './routes/emr/cdsRoutes.js';

// EMR — Diagnosis & Problem List
import diagnosisRoutes from './routes/emr/diagnosisRoutes.js';

// Prometheus metrics
import metricsRoutes from './routes/metrics/metricsRoutes.js';

// Swagger loader
import swaggerLoader from './utils/swaggerLoader.js';

// ====================================
// ENVIRONMENT AND INITIALIZATION
// ====================================

dotenv.config();
import './utils/validateEnv.js';

// Create Express app
const app = express();
app.set('trust proxy', 1); // Required for Render or Cloudflare

// ====================================
// SWAGGER SETUP
// ====================================

let swaggerDocument;
try {
  swaggerDocument = swaggerLoader();
  if (!swaggerDocument) throw new Error('Failed to load Swagger documentation.');
  logger.info('✅ Swagger documentation validated and loaded.');
} catch (err) {
  logger.error('❌ Swagger load failed:', err.message);
  process.exit(1);
}

// ====================================
// GLOBAL MIDDLEWARE
// ====================================

app.use(helmet({
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // For Swagger UI
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false, // Allow Swagger UI to load
}));

// HTTPS enforcement in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

app.use(compression({ threshold: 1024 })); // Only compress responses > 1KB
app.use(requestIdMiddleware);
app.use(apiVersionMiddleware);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));
app.use(corsMiddleware);

// Logging
app.use(loggingMiddleware);
app.use(logger.morganMiddleware);

// User context middleware
app.use(attachUserContext);
// NOTE: normalizeIdentityFields runs AFTER JWT auth below

// Universal audit log — fire-and-forget, captures all routes, handles null user gracefully
app.use(auditLogMiddleware);
app.use(selfHealingMiddleware);
app.use(prometheusMiddleware);

// ====================================
// PUBLIC ROUTES (No authentication required)
// ====================================

// Swagger docs — disabled in production to prevent API surface exposure
const isProduction = (process.env.NODE_ENV || '').toLowerCase() === 'production';
if (!isProduction) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
} else {
  app.use('/api-docs', (req, res) => res.status(404).json({ success: false, message: 'Not found' }));
}
// Rate-limit public endpoints to prevent abuse/recon
app.use('/metrics', genericLimiter, metricsRoutes);
app.use('/api/v1/internal', validateApiKey, internalRoutes);

// Root health check — rate limited, minimal info in production
app.get('/', genericLimiter, async (req, res, next) => {
  try {
    const db = (await import('./config/database.js')).default;
    const dbHealth = await db.healthCheck();
    if (!dbHealth.healthy) {
      return res.status(503).json({
        status: 'degraded',
        message: 'Database unavailable',
      });
    }
    res.json({
      status: 'healthy',
      message: 'VH Health API is running.',
      version: process.env.API_VERSION || '1.0.0',
    });
  } catch (err) {
    next(err);
  }
});
app.head('/', async (req, res, next) => {
  try {
    const db = (await import('./config/database.js')).default;
    const health = await db.healthCheck();
    res.status(health.healthy ? 200 : 503).end();
  } catch (err) {
    next(err);
  }
});

// Public API routes
app.use('/api/v1/auth', patientRateLimiter, routes.auth); // Patient Auth
app.use('/api/v1/otp', patientRateLimiter, routes.otp);
app.use('/api/v1/health', genericLimiter, healthRoutes);

// ABDM gateway callbacks (public — no JWT/API key, validated via ABDM request signature)
app.use('/api/v1/abdm', abdmCallbackRoutes);

// ====================================
// API KEY & AUTH MIDDLEWARE
// Apply to all routes below this point
// ====================================

app.use(validateApiKey);

// Infrastructure routes (debug, swagger, version, rbac) — require API key
app.use('/api/v1', infrastructureRoutes);

// ====================================
// API KEY ONLY ROUTES (no JWT required)
// Mount before global JWT auth so Flutter can call these without a JWT
// ====================================

// Patient dashboard — Flutter app uses API key only for this
app.use('/api/v1/dashboard', dashboardRateLimiter, dashboardRoutes);

// Campus config — staff app uses API key only for this
app.use('/api/v1/config', configRoutes);

// HL7v2 messaging — mounted before global JWT auth so /receive works with API key only.
// JWT is enforced on /generate within the route file itself.
app.use('/api/v1/hl7', hl7Routes);

app.use(jwtAuth);  // Single JWT middleware for all authenticated routes
app.use(normalizeIdentityFields); // runs AFTER JWT auth

// ====================================
// AUTHENTICATED ROUTES (API key required)
// ====================================

// User management
app.use('/api/v1/users', patientRateLimiter, userRoutes);

// Healthcare services - Modularized
app.use('/api/v1/appointments', patientRateLimiter, phiAccessLogger('APPOINTMENT'), appointmentRoutes);
app.use('/api/v1/records', patientRateLimiter, requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS', 'PATIENT'), phiAccessLogger('MEDICAL_RECORD'), recordRoutes);
app.use('/api/v1/investigations', patientRateLimiter, requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'LAB_STAFF', 'MEDICAL_RECORDS'), phiAccessLogger('INVESTIGATION'), investigationRoutes);
app.use('/api/v1/pharmacy-orders', patientRateLimiter, requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF'), phiAccessLogger('PHARMACY_ORDER'), pharmacyRoutes);
app.use('/api/v1/prescriptions', patientRateLimiter, requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'PATIENT'), phiAccessLogger('PRESCRIPTION'), prescriptionRoutes);
app.use('/api/v1/delivery', patientRateLimiter, requireRole('ADMIN', 'SUPER_ADMIN', 'PHARMACY_STAFF', 'DELIVERY_STAFF'), deliveryRoutes);
app.use('/api/v1/departments', departmentRoutes);
app.use('/api/v1/doctors', doctorRoutes);
app.use('/api/v1/notifications', notificationRoutes);

// Patient reminders (medication) — JWT via global jwtAuth above
app.use('/api/v1/reminders', patientRateLimiter, reminderRoutes);
app.use('/api/v1/steps', patientRateLimiter, stepsRoutes);
app.use('/api/v1/rewards', patientRateLimiter, stepRewardsRoutes);

// Healthcare services - Legacy (to be modularized)
app.use('/api/v1/devices', deviceRoutes);

app.use('/api/v1/feedback', patientRateLimiter, routes.feedback);
app.use('/api/v1/sos', patientRateLimiter, routes.sos);
app.use('/api/v1/search', searchRoutes);
app.use('/api/v1/upload', routes.upload);

// GDPR Data Export + Erasure
app.use('/api/v1/data-export', dataExportRateLimiter, dataExportRoutes);
app.use('/api/v1/gdpr', dataExportRateLimiter, gdprRoutes);

// Session Management (view/revoke active sessions)
app.use('/api/v1/sessions', sessionRoutes);

// Admin 2FA (TOTP) — some endpoints public (verify), some require auth
app.use('/api/v1/auth/admin/totp', totpRoutes);

// HIPAA Consent Management (requires JWT + role check; IDOR enforced in route file)
app.use('/api/v1/consent', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'PATIENT'), consentRoutes);

// ABDM patient-facing routes (JWT required — ABHA registration, consent management)
app.use('/api/v1/abdm', abdmPatientRoutes);

// ====================================
// ROLE-PROTECTED ROUTES (JWT enforced globally above)
// ====================================

app.use('/api/v1/staff', staffRoutes);

// Bed/Ward management
app.use('/api/v1/beds', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF'), bedRouter);
app.use('/api/v1/beds', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF'), bedManagementRoutes);
app.use('/api/v1/wards', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF'), wardRouter);

// FHIR R4 interoperability — restricted to clinical staff (exposes PHI)
app.use('/api/v1/fhir', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'), phiAccessLogger('FHIR_RESOURCE'), fhirRoutes);

// Clinical Document Export & Import
app.use('/api/v1/documents', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'), phiAccessLogger('CLINICAL_DOCUMENT'), documentRoutes);

// Clinical workflows: MAR, NEWS2, Nurse Handover
app.use('/api/v1/clinical', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF'), phiAccessLogger('CLINICAL_WORKFLOW'), clinicalRoutes);

// EMR — Clinical Documentation (notes, timeline)
app.use('/api/v1/emr', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'), phiAccessLogger('CLINICAL_NOTE'), clinicalNotesRoutes);

// EMR — ADT (Admission/Discharge/Transfer)
app.use('/api/v1/emr', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'), phiAccessLogger('ADMISSION'), admissionRoutes);

// EMR — CPOE (Order Entry)
app.use('/api/v1/emr', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'), phiAccessLogger('CLINICAL_ORDER'), orderRoutes);

// EMR — Vitals Charting & I/O
app.use('/api/v1/emr', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'), phiAccessLogger('VITAL_SIGN'), vitalsRoutes);

// EMR — Clinical Decision Support (CDS) Engine
app.use('/api/v1/emr', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'), phiAccessLogger('CLINICAL_DECISION'), cdsRoutes);

// EMR — Diagnosis & Problem List
app.use('/api/v1/emr', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'), phiAccessLogger('DIAGNOSIS'), diagnosisRoutes);

// Centralized admin namespace — IP allowlisted when ADMIN_IP_ALLOWLIST is set
app.use('/api/v1/admin', requireRole('ADMIN', 'SUPER_ADMIN'), adminIpAllowlist, adminRateLimiter, adminDashboardRoutes);

// System settings + status
app.use('/api/v1/system', requireRole('ADMIN', 'SUPER_ADMIN'), adminRateLimiter, systemRoutes);

// Audit + system logs
app.use('/api/v1/logs', requireRole('ADMIN', 'SUPER_ADMIN'), adminRateLimiter, logRoutes);

// Radiology
app.use('/api/v1/radiology', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'RADIOLOGY_STAFF'), phiAccessLogger('RADIOLOGY'), radiologyRoutes);

// Dietary / Nutrition
app.use('/api/v1/dietary', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'DIETARY_STAFF'), phiAccessLogger('DIETARY'), dietaryRoutes);

// Operating Theatre
app.use('/api/v1/theatre', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'OT_STAFF'), phiAccessLogger('OPERATING_THEATRE'), theatreRoutes);

// Blood Bank
app.use('/api/v1/blood-bank', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'BLOOD_BANK_STAFF'), phiAccessLogger('BLOOD_BANK'), bloodBankRoutes);

// Billing & Invoicing (mount-level role gate + route-level checks for mutations)
app.use('/api/v1/billing', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'BILLING_STAFF', 'PATIENT'), billingRoutes);

// Quality & Infection Control (route-level role checks)
app.use('/api/v1/quality', qualityRoutes);

// Referral Management (route-level role checks)
app.use('/api/v1/referrals', phiAccessLogger('REFERRAL'), referralRoutes);

// Inter-staff messaging
app.use('/api/v1/messaging', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'LAB_STAFF', 'HR_STAFF', 'GENERAL_STAFF', 'DELIVERY_STAFF', 'RECEPTIONIST'), messagingRoutes);

// Compliance: Breach Notification + Audit Search (admin only)
app.use('/api/v1/compliance', requireRole('ADMIN', 'SUPER_ADMIN'), adminRateLimiter, breachRoutes);
app.use('/api/v1/compliance', requireRole('ADMIN', 'SUPER_ADMIN'), adminRateLimiter, auditSearchRoutes);

// Serve report exports — protected behind JWT + admin role to prevent unauthorized access
app.use('/exports', requireRole('ADMIN', 'SUPER_ADMIN'), express.static('exports'));

// ====================================
// ERROR HANDLING
// ====================================

// Fallback rate limiter
app.use(genericLimiter);

// CORS error handler
app.use(corsErrorHandler);

// Global error handler
app.use(errorHandlerMiddleware);

// ====================================
// DEVELOPMENT LOGGING
// ====================================

if (process.env.NODE_ENV === 'development') {
  logger.info('\n🚀 API Routes Summary:');
  logger.info('=====================================');

  logger.info('\n📋 Public Routes:');
  logger.info('  - GET    / (Health check)');
  logger.info('  - ALL    /api-docs (Swagger documentation)');
  logger.info('  - ALL    /api/v1/auth/*');
  logger.info('  - ALL    /api/v1/otp/*');
  logger.info('  - ALL    /api/v1/health/* (Some routes protected)');
  logger.info('  - MIXED  /api/v1/* (infrastructure)');

  logger.info('\n🔐 API Key Protected Routes:');
  logger.info('  - ALL    /api/v1/users/*');
  logger.info('  - ALL    /api/v1/appointments/*');
  logger.info('  - ALL    /api/v1/records/*');
  logger.info('  - ALL    /api/v1/investigations/*');
  logger.info('  - ALL    /api/v1/pharmacy-orders/*');
  logger.info('  - ALL    /api/v1/departments/*');
  logger.info('  - ALL    /api/v1/doctors/*');
  logger.info('  - ALL    /api/v1/notifications/*');
  logger.info('  - ALL    /api/v1/devices/*');
  logger.info('  - ALL    /api/v1/feedback/*');
  logger.info('  - ALL    /api/v1/sos/*');
  logger.info('  - ALL    /api/v1/upload/*');

  logger.info('\n🔑 JWT Protected Routes:');
  logger.info('  - ALL    /api/v1/staff/*');
  logger.info('  - ALL    /api/v1/admin/*  (Admin Dashboard + all admin submodules)');

  logger.info('\n✅ Modularized Routes:');
  logger.info('  - ✓ Staff (/api/v1/staff)');
  logger.info('  - ✓ Pharmacy (/api/v1/pharmacy-orders)');
  logger.info('  - ✓ Investigation (/api/v1/investigations)');
  logger.info('  - ✓ Appointment (/api/v1/appointments)');
  logger.info('  - ✓ Medical Records (/api/v1/records)');
  logger.info('  - ✓ Health (/api/v1/health)');
  logger.info('  - ✓ Department (/api/v1/departments)');
  logger.info('  - ✓ Doctors (/api/v1/doctors)');
  logger.info('  - ✓ Users (/api/v1/users)');
  logger.info('  - ✓ Notifications (/api/v1/notifications)');
  logger.info('  - ✓ Authentication (/api/v1/auth)');
  logger.info('  - ✓ Infrastructure (/api/v1/*)');
  logger.info('=====================================\n');
}

export default app;
