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
import apiVersionMiddleware from './middleware/apiVersionMiddleware.js';
import { attachUserContext } from './middleware/attachUserContext.js';
import { auditLogMiddleware } from './middleware/auditLog.js';
import corsMiddleware, { corsErrorHandler } from './middleware/corsMiddleware.js';
import { errorHandlerMiddleware } from './middleware/errorHandlerMiddleware.js';
import { adminIpAllowlist } from './middleware/ipAllowlistMiddleware.js';
import jwtAuth, { enforceFullScope } from './middleware/jwtMiddleware.js';
import tenantContextMiddleware from './middleware/tenantContextMiddleware.js';
import tenantRoutes from './routes/admin/tenantRoutes.js';
import loggingMiddleware from './middleware/loggingMiddleware.js';
import { normalizeIdentityFields } from './middleware/normalizeIdentityFields.js';
import { phiAccessLogger } from './middleware/phiAccessMiddleware.js';
import { prometheusMiddleware } from './middleware/prometheusMiddleware.js';
import { patientRateLimiter, genericLimiter, adminRateLimiter, dataExportRateLimiter, dashboardRateLimiter } from './middleware/rateLimitMiddleware.js';
import { requireRole } from './middleware/rbacMiddleware.js';
import requestIdMiddleware from './middleware/requestIdMiddleware.js';
import { sentryScopeMiddleware } from './middleware/sentryScopeMiddleware.js';
import { selfHealingMiddleware } from './middleware/selfHealingMiddleware.js';
import validateApiKey from './middleware/validateApiKey.js';
import { publicCache } from './middleware/cacheControlMiddleware.js';
import { success, error } from './utils/responseHelper.js';

// ====================================
// ROUTE IMPORTS - Organized by category
// ====================================

// Public / mixed modules
import { callbackRouter as abdmCallbackRoutes, patientRouter as abdmPatientRoutes } from './routes/abdm/abdmRoutes.js';
import adminDashboardRoutes from './routes/admin/index.js';
import clinicalAiAdminRoutes from './routes/admin/clinicalAiRoutes.js';
import clinicalAiClinicalUseRoutes from './routes/admin/clinicalAi/clinicalUseRoutes.js';
import { CLINICAL_AI_USER_ROLES_LIST } from './routes/admin/clinicalAi/shared.js';
import adminForecastRoutes from './routes/admin/forecastRoutes.js';
import appointmentRoutes from './routes/appointment/index.js';
import totpRoutes from './routes/auth/totpRoutes.js';
import bedManagementRoutes from './routes/bed/bedManagementRoutes.js';
import { bedRouter, wardRouter } from './routes/bed/bedRoutes.js';
import bedInspectionRoutes from './routes/bed/bedInspectionRoutes.js';
import edRoutesForClinicalStaff from './routes/admin/edRoutes.js';
import ipdSupportRoutes from './routes/ipd/ipdSupportRoutes.js';
import auditSearchRoutes from './routes/compliance/auditSearchRoutes.js';
import breachRoutes from './routes/compliance/breachRoutes.js';
import complianceIndicatorsRoutes from './routes/compliance/indicatorsRoutes.js';
import configRoutes from './routes/configRoutes.js';
import dashboardRoutes from './routes/dashboard/index.js';
import deliveryRoutes from './routes/delivery/index.js';
import departmentRoutes from './routes/department/index.js';
import deviceRoutes from './routes/deviceRoutes.js';
import doctorRoutes from './routes/doctor/index.js';
import healthRoutes from './routes/health/index.js';
import uptimeRoutes from './routes/health/uptimeRoutes.js';
import realtimeRoutes from './routes/realtime/realtimeRoutes.js';
import realtimeTicketRoutes from './routes/realtime/realtimeTicketRoutes.js';
import chatbotRoutes from './routes/chatbot/chatbotRoutes.js';
import routes from './routes/index.js';
import infrastructureRoutes from './routes/infrastructure/index.js';
import internalRoutes from './routes/internalRoutes.js';
import investigationRoutes from './routes/investigation/index.js';
import logRoutes from './routes/logs/index.js';
import notificationRoutes from './routes/notification/index.js';
import patientSearchRoutes from './routes/patient/patientSearchRoutes.js';
import pharmacyRoutes from './routes/pharmacy/index.js';
import prescriptionRoutes from './routes/prescription/index.js';
import recordRoutes from './routes/record/index.js';
import housekeepingRoutes from './routes/housekeepingRoutes.js';
import searchRoutes from './routes/searchRoutes.js';
import staffRoutes from './routes/staff/index.js';
import storageRoutes from './routes/storage/storageRoutes.js';
import uploadRoutes from './routes/upload/uploadRoutes.js';
import userRoutes from './routes/user/index.js';
import patientChatbotRoutes from './routes/patient/chatbotRoutes.js';
import patientVirtualWardRoutes from './routes/patient/virtualWardRoutes.js';

// FHIR interoperability
import fhirRoutes from './routes/fhir/fhirRoutes.js';
import cdsHooksRoutes from './routes/clinical/cdsHooksRoutes.js';

// Clinical Document Export & Import
import documentRoutes from './routes/documents/documentRoutes.js';

// HL7v2 messaging
import hl7Routes from './routes/hl7/hl7Routes.js';

// Admin (centralized under /api/v1/admin)

// System settings and logs (admin portal: /api/v1/system/* and /api/v1/logs/*)
import systemRoutes from './routes/system/index.js';

// Patient dashboard (API key only, no JWT)

// Config routes (API key only, no JWT)

// GDPR Data Export + Erasure
import dataExportRoutes from './routes/dataExportRoutes.js';
import gdprRoutes from './routes/gdprRoutes.js';

// HIPAA Consent Management
import consentRoutes from './routes/consentRoutes.js';

// Session Management (view/revoke active sessions)
import sessionRoutes from './routes/sessionRoutes.js';

// Admin 2FA (TOTP)

// Compliance (Breach Notification + Audit Search)

// ABDM (Ayushman Bharat Digital Mission) Integration

// Billing & Invoicing
import billingRoutes from './routes/billing/billingRoutes.js';
import billingV2Routes from './routes/billing/billingV2Routes.js';
import labRoutes from './routes/lab/labRoutes.js';
import insuranceClaimsRoutes from './routes/insurance/claimsRoutes.js';
import admissionEnhancementRoutes from './routes/insurance/admissionEnhancementRoutes.js';
import pmjayRoutes from './routes/insurance/pmjayRoutes.js';
import maternityRoutes from './routes/maternity/maternityRoutes.js';
import productivityRoutes from './routes/productivity/productivityRoutes.js';
import dashboardsRoutes from './routes/dashboards/dashboardsRoutes.js';
import patientPortalRoutes from './routes/portal/patientPortalRoutes.js';
import staffMessagingRoutes from './routes/portal/staffMessagingRoutes.js';
import dischargeRoutes from './routes/discharge/dischargeRoutes.js';
import revenueCycleRoutes from './routes/billing/revenueCycleRoutes.js';

// Quality & Infection Control
import qualityRoutes from './routes/quality/qualityRoutes.js';

// Referral Management
import referralRoutes from './routes/referral/referralRoutes.js';

// Department modules: Radiology, Dietary, Operating Theatre, Blood Bank
import radiologyRoutes from './routes/radiology/radiologyRoutes.js';
import dietaryRoutes from './routes/dietary/dietaryRoutes.js';
import theatreRoutes from './routes/theatre/theatreRoutes.js';
import orBoardRoutes from './routes/theatre/orBoardRoutes.js';
import anesthesiaChartRoutes from './routes/theatre/anesthesiaChartRoutes.js';
import microbiologyRoutes from './routes/lab/microbiologyRoutes.js';
import labPanelRoutes from './routes/lab/labPanelRoutes.js';
import paediatricImmunisationRoutes from './routes/paediatric/paediatricImmunisationRoutes.js';
import pcpndtRoutes from './routes/compliance/pcpndtRoutes.js';
import bmwAndDrugReturnRoutes from './routes/compliance/bmwAndDrugReturnRoutes.js';
import icuRoutes from './routes/clinical/icuRoutes.js';
import deathCertificationRoutes from './routes/clinical/deathCertificationRoutes.js';
import dialysisRoutes from './routes/clinical/dialysisRoutes.js';
import bloodBankRoutes from './routes/bloodbank/bloodBankRoutes.js';

// Inter-staff messaging
import messagingRoutes from './routes/messaging/messagingRoutes.js';

// Patient reminders (medication)
import reminderRoutes from './routes/reminders/index.js';
import stepsRoutes from './routes/steps/stepsRoutes.js';
import stepRewardsRoutes from './routes/steps/stepRewardsRoutes.js';
import gamificationRoutes from './routes/gamification/gamificationRoutes.js';
import adminGamificationRoutes from './routes/gamification/adminGamificationRoutes.js';

// Clinical workflows (MAR, NEWS2, Handover)
import clinicalRoutes from './routes/clinical/clinicalRoutes.js';
import nursingAssessmentRoutes from './routes/clinical/nursingAssessmentRoutes.js';
import clinicalAssessmentRoutes from './routes/clinical/assessmentRoutes.js';

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

const CLINICAL_STAFF_ROLES = [
  'ADMIN',
  'SUPER_ADMIN',
  'DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
  'NURSING_STAFF',
  'MEDICAL_RECORDS',
  // E-4 — pharmacy needs read access on /emr/orders (medication orders
  // they're about to dispense) + verify/complete on the same. Per
  // route-level controllers further-gate by order_type when needed.
  // Finding: 2026-05-08-inpatient-admission-pharmacy-rbac-emr-orders-blocked.
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
  // Wave-4B-1 — ICU/admission-desk roles must reach /emr/admit before
  // the per-allocation ICU tier check fires (admissionService runs the
  // ICU_ALLOCATE_ROLES gate downstream). Without these, the seeded
  // ICU_NURSE/ADMISSION_OFFICER tokens get a generic 403 from this
  // top-level gate and never reach the tier check. Finding:
  // 2026-05-10-emergency-walk-in-admission-icu-nurse-emr-gate-blocks-ccu-admit.
  'ICU_NURSE',
  'ICU_INCHARGE',
  'ADMISSION_OFFICER',
  'IPD_COUNSELLOR',
];
const CLINICAL_AI_CONTROL_ROLES = [
  'ADMIN',
  'SUPER_ADMIN',
  'IT',
  'IT_ADMIN',
  'IT_STAFF',
  'SYSTEM_ADMIN',
];

function pathMatchesPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function phiAccessLoggerForPaths(recordType, matchers) {
  const loggerMiddleware = phiAccessLogger(recordType);
  return (req, res, next) => {
    const requestPath = (req.originalUrl || req.url || '').split('?')[0].toLowerCase();
    const shouldLog = matchers.some((matcher) => (
      matcher instanceof RegExp
        ? matcher.test(requestPath)
        : pathMatchesPrefix(requestPath, matcher)
    ));

    if (!shouldLog) return next();
    return loggerMiddleware(req, res, next);
  };
}

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
app.use(sentryScopeMiddleware);
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
  app.use('/api-docs', (req, res) => error(res, 'Not found', 404));
}
// Rate-limit public endpoints to prevent abuse/recon
app.use('/metrics', genericLimiter, metricsRoutes);
app.use('/api/v1/internal', validateApiKey, internalRoutes);

// Local-disk storage stream — mounted BEFORE both validateApiKey and jwtAuth
// so the patient client can download files via a plain HTTP GET. The HMAC
// token in the query string IS the auth (semantics match Cloudflare R2
// signed URLs). Only exercised when R2 env vars are absent (dev/CI
// fallback); prod with R2 returns r2.cloudflarestorage.com URLs that bypass
// the backend entirely. `genericLimiter` guards against trivial DoS / mass
// download attempts even though the token itself is unforgeable.
app.use('/api/v1/storage', genericLimiter, storageRoutes);

// Root health check — rate limited, minimal info in production. Proves the
// Prisma driver is live with a cheap `SELECT 1`; circuit-breaker state is
// not included here to keep this probe as fast as possible (use
// /health/metrics for the fuller picture).
async function probeDb() {
  try {
    const { default: prisma } = await import('./lib/prisma.js');
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
app.get('/', genericLimiter, async (req, res, next) => {
  try {
    if (!(await probeDb())) {
      return error(res, 'Database unavailable', 503, { safe: true, status: 'degraded' });
    }
    success(res, {
      status: 'healthy',
      version: process.env.API_VERSION || '1.0.0',
    }, 'VH Health API is running.');
  } catch (err) {
    next(err);
  }
});
app.head('/', async (req, res, next) => {
  try {
    res.status((await probeDb()) ? 200 : 503).end();
  } catch (err) {
    next(err);
  }
});

// Public API routes
app.use('/api/v1/auth', patientRateLimiter, routes.auth); // Patient Auth
app.use('/api/v1/otp', patientRateLimiter, routes.otp);
app.use('/api/v1/health', genericLimiter, healthRoutes);
app.use('/api/v1/realtime', genericLimiter, realtimeRoutes);

// ABDM gateway callbacks (public — no JWT/API key, validated via ABDM request signature)
app.use('/api/v1/abdm', abdmCallbackRoutes);

// ====================================
// PUBLIC HEALTH CHECK (no auth required — for Render/uptime monitors)
// ====================================
app.get('/health', (req, res) => success(res, { status: 'ok', service: 'vh-health-backend' }));
app.get('/api/health', (req, res) => success(res, { status: 'ok', service: 'vh-health-backend' }));
app.use('/health', genericLimiter, uptimeRoutes);

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
// Narrow-scope tokens (e.g. mfa_setup) must never reach non-auth routes.
// The two setup-enroll/confirm endpoints are mounted under /api/v1/auth
// (above this line) and carry their own requireSetupScope guard; every
// route past this line gets the inverse guard.
app.use(enforceFullScope);
app.use(tenantContextMiddleware);  // Resolves req.tenantId after JWT auth
app.use(normalizeIdentityFields); // runs AFTER JWT auth

// ====================================
// AUTHENTICATED ROUTES (API key required)
// ====================================

// Realtime ticket exchange — JWT-authed; issues short-lived WS-scoped tokens
// for browser clients that can't expose their primary JWT to JS.
app.use('/api/v1/realtime', genericLimiter, realtimeTicketRoutes);

// AI symptom-checker (Claude API). JWT-authed via the global middleware above.
app.use('/api/v1/chatbot', patientRateLimiter, chatbotRoutes);

// User management
app.use('/api/v1/users', patientRateLimiter, userRoutes);
app.use(
  '/api/v1/patient/chatbot',
  patientRateLimiter,
  requireRole('PATIENT', 'SUPER_ADMIN'),
  phiAccessLogger('PATIENT_CHATBOT'),
  patientChatbotRoutes
);
app.use(
  '/api/v1/patient/virtual-ward',
  patientRateLimiter,
  requireRole('PATIENT', 'ADMIN', 'SUPER_ADMIN', 'NURSING_STAFF'),
  phiAccessLogger('VIRTUAL_WARD_CHECK_IN'),
  patientVirtualWardRoutes
);

// Healthcare services - Modularized
app.use('/api/v1/appointments', patientRateLimiter, phiAccessLogger('APPOINTMENT'), appointmentRoutes);
app.use('/api/v1/records', patientRateLimiter, requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS', 'PATIENT'), phiAccessLogger('MEDICAL_RECORD'), recordRoutes);
app.use('/api/v1/investigations', patientRateLimiter, requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'LAB_STAFF', 'MEDICAL_RECORDS', 'PATIENT'), phiAccessLogger('INVESTIGATION'), investigationRoutes);
app.use('/api/v1/pharmacy-orders', patientRateLimiter, requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'PATIENT'), phiAccessLogger('PHARMACY_ORDER'), pharmacyRoutes);
// Alias mount: /api/v1/pharmacy/* → same sub-routes as /api/v1/pharmacy-orders/*.
// The admin /dashboard/pharmacy/inventory page calls /pharmacy/inventory/*
// (summary/low-stock/expiring-soon/expired); the canonical mount at
// /pharmacy-orders/inventory/* still serves existing clients.
app.use('/api/v1/pharmacy', patientRateLimiter, requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'PATIENT'), phiAccessLogger('PHARMACY_ORDER'), pharmacyRoutes);
app.use('/api/v1/prescriptions', patientRateLimiter, requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'PATIENT'), phiAccessLogger('PRESCRIPTION'), prescriptionRoutes);
app.use('/api/v1/delivery', patientRateLimiter, requireRole('ADMIN', 'SUPER_ADMIN', 'PHARMACY_STAFF', 'DELIVERY_STAFF', 'PATIENT'), deliveryRoutes);
app.use('/api/v1/departments', publicCache(300), departmentRoutes);
app.use('/api/v1/doctors', publicCache(300), doctorRoutes);
app.use('/api/v1/notifications', notificationRoutes);
// Clinical-staff patient lookup (Cmd+K picker on the staff app). Kept
// open to clinical roles + admins; medical-records staff also need it
// for chart finding. Patient self-search isn't applicable.
app.use(
  '/api/v1/patients',
  requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS', 'RECEPTIONIST', 'GENERAL_STAFF'),
  patientSearchRoutes,
);
app.use('/api/v1/upload', patientRateLimiter, uploadRoutes);

// Patient reminders (medication) — JWT via global jwtAuth above
app.use('/api/v1/reminders', patientRateLimiter, reminderRoutes);
app.use('/api/v1/steps', patientRateLimiter, stepsRoutes);
app.use('/api/v1/rewards', patientRateLimiter, stepRewardsRoutes);
app.use('/api/v1/gamification', patientRateLimiter, gamificationRoutes);

// Healthcare services - Legacy (to be modularized)
app.use('/api/v1/devices', deviceRoutes);

app.use('/api/v1/feedback', patientRateLimiter, routes.feedback);
app.use('/api/v1/sos', patientRateLimiter, routes.sos);
app.use('/api/v1/search', searchRoutes);

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

// Housekeeping — top-level canonical surface. Same controller already
// mounted under /api/v1/staff/admin/housekeeping/* and
// /api/v1/staff/hr/housekeeping/* via staff/index.js; this is the
// canonical /api/v1/housekeeping/* path the staff app + admin portal
// expect. Finding:
// 2026-05-09-inpatient-admission-housekeeping-api-routes-absent.
app.use(
  '/api/v1/housekeeping',
  requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'LAB_STAFF', 'HR_STAFF', 'GENERAL_STAFF'),
  housekeepingRoutes,
);

// Bed/Ward management.
//
// Wave-4B-1 — parent gate widened to admit GENERAL_STAFF (the seeded
// housekeeping role) so they can close the cleaning loop via
// POST /:id/ready. Sensitive bed-management endpoints (admit / transfer
// / discharge) re-narrow to clinical roles via per-route requireRole
// guards inside bedManagementRoutes itself. Finding:
//   2026-05-09-inpatient-admission-housekeeping-general-staff-cannot-mark-bed-ready
const BED_PARENT_ROLES = [
  'ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF',
  'GENERAL_STAFF', 'HOUSEKEEPING_STAFF',
];
app.use('/api/v1/beds', requireRole(...BED_PARENT_ROLES), bedRouter);
app.use('/api/v1/beds', requireRole(...BED_PARENT_ROLES), bedManagementRoutes);
app.use('/api/v1/wards', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF'), wardRouter);
// D1 — bed inspection / consumer-choice flow. Receptionists need full
// access; admission officers + nursing also; admin for audit.
app.use('/api/v1/bed-inspections', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'RECEPTIONIST', 'ADMISSION_OFFICER'), bedInspectionRoutes);

// Emergency department triage — parallel mount at /api/v1/ed for clinical
// staff (NURSING_STAFF in particular). The legacy /api/v1/admin/ed/*
// routes still exist and remain admin-gated for the analytics/reporting
// surface, but the actual triage workflow is a nursing task and must
// not require an ADMIN/SUPER_ADMIN token. See finding
// 2026-05-08-emergency-walk-in-nurse-triage-rbac-blocks-nurses.
app.use(
  '/api/v1/ed',
  requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'ER_STAFF', 'MEDICAL_RECORDS'),
  phiAccessLogger('ER_TRIAGE'),
  edRoutesForClinicalStaff,
);

// IPD support subsystem — advance deposits, attendant passes, ward
// indents (architectural item A4 / migration 174). RBAC is broad
// because the routes file fans out into operations owned by different
// roles (billing for deposits, admission for passes, pharmacy/nursing
// for ward indents); finer-grained per-route checks live in the
// service layer.
app.use(
  '/api/v1/ipd',
  requireRole(
    'ADMIN', 'SUPER_ADMIN',
    'BILLING_STAFF', 'BILLING_INCHARGE', 'FINANCE_INCHARGE',
    'NURSING_STAFF', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE',
    'RECEPTIONIST', 'ADMISSION_OFFICER',
  ),
  phiAccessLogger('IPD_SUPPORT'),
  ipdSupportRoutes,
);

// FHIR R4 interoperability — restricted to clinical staff (exposes PHI)
app.use('/api/v1/fhir', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'), phiAccessLogger('FHIR_RESOURCE'), fhirRoutes);

// CDS Hooks (https://cds-hooks.org/) — standards-compliant decision-support
// endpoints consumed by external EHR systems. Same RBAC as FHIR since the
// invoke handlers may surface PHI in card detail.
app.use('/api/v1/cds-services', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'), phiAccessLogger('CDS_HOOKS'), cdsHooksRoutes);

// Clinical Document Export & Import
app.use('/api/v1/documents', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'), phiAccessLogger('CLINICAL_DOCUMENT'), documentRoutes);

// Clinical workflows: MAR, NEWS2, Nurse Handover
app.use('/api/v1/clinical', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF'), phiAccessLogger('CLINICAL_WORKFLOW'), clinicalRoutes);
app.use('/api/v1/nursing-assessments', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF'), phiAccessLogger('NURSING_ASSESSMENT'), nursingAssessmentRoutes);

// Clinical assessments: pain / fall-risk / growth-chart (Phase F2)
app.use('/api/v1/clinical/assessments', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT'), phiAccessLogger('CLINICAL_ASSESSMENT'), clinicalAssessmentRoutes);

// EMR — one role gate, then route-family PHI logging only for matching paths.
app.use('/api/v1/emr', requireRole(...CLINICAL_STAFF_ROLES));
app.use('/api/v1/emr', phiAccessLoggerForPaths('CLINICAL_NOTE', [
  '/api/v1/emr/notes',
  '/api/v1/emr/timeline',
  '/api/v1/emr/downtime-snapshot',
]), clinicalNotesRoutes);
app.use('/api/v1/emr', phiAccessLoggerForPaths('ADMISSION', [
  '/api/v1/emr/admit',
  '/api/v1/emr/admission',
  '/api/v1/emr/admissions',
  /^\/api\/v1\/emr\/\d+\//,
]), admissionRoutes);
app.use('/api/v1/emr', phiAccessLoggerForPaths('CLINICAL_ORDER', [
  '/api/v1/emr/orders',
  '/api/v1/emr/order-sets',
]), orderRoutes);
app.use('/api/v1/emr', phiAccessLoggerForPaths('VITAL_SIGN', [
  '/api/v1/emr/vitals',
  '/api/v1/emr/io',
]), vitalsRoutes);
app.use('/api/v1/emr', phiAccessLoggerForPaths('CLINICAL_DECISION', [
  '/api/v1/emr/cds',
]), cdsRoutes);
app.use('/api/v1/emr', phiAccessLoggerForPaths('DIAGNOSIS', [
  '/api/v1/emr/diagnosis',
  '/api/v1/emr/icd10',
]), diagnosisRoutes);

// Centralized admin namespace — IP allowlisted when ADMIN_IP_ALLOWLIST is set
//
// Clinical AI exposure splits into TWO mount families per the Phase 0
// rollout plan (docs/CLINICAL_AI_ROLLOUT_PLAN.md):
//
//   * Control plane — governance, model registry, drift canary, audit,
//     break-glass, prompt registry. Admin / IT roles only. Mounted at
//     both /api/v1/admin/clinical-ai (legacy alias the existing admin
//     UI still uses) and /api/v1/clinical-ai/control (the new canonical
//     path). Both mount the SAME router; both apply the same middleware.
//
//   * Clinical plane — generate drafts, review queue, sign / edit /
//     reject. Clinical roles + ADMIN/SUPER_ADMIN. Mounted only at
//     /api/v1/clinical-ai/clinical. Used by apps/staff Flutter (Phase
//     2) and any clinician-facing web build (Phase 3).
//
// The legacy /admin/clinical-ai alias keeps existing admin-portal API
// callers working unchanged for at least one release. Once the admin
// portal client is updated to /clinical-ai/control, the alias can be
// removed.
app.use(
  '/api/v1/admin/clinical-ai',
  requireRole(...CLINICAL_AI_CONTROL_ROLES),
  adminIpAllowlist,
  adminRateLimiter,
  clinicalAiAdminRoutes
);
app.use(
  '/api/v1/clinical-ai/control',
  requireRole(...CLINICAL_AI_CONTROL_ROLES),
  adminIpAllowlist,
  adminRateLimiter,
  clinicalAiAdminRoutes
);
app.use(
  '/api/v1/clinical-ai/clinical',
  requireRole(...CLINICAL_AI_USER_ROLES_LIST),
  // Intentionally NOT applying adminIpAllowlist — clinical traffic
  // comes from arbitrary hospital workstations / tablets, not a fixed
  // admin IP set. Phase 1 of the rollout adds an internal-only ingress
  // class for this mount; for now, JWT + role gating is the only
  // network-level filter.
  clinicalAiClinicalUseRoutes
);
app.use(
  '/api/v1/admin/forecast',
  requireRole(...CLINICAL_AI_CONTROL_ROLES),
  adminIpAllowlist,
  adminRateLimiter,
  adminForecastRoutes
);
app.use(
  '/api/v1/admin/tenants',
  requireRole('SUPER_ADMIN'),
  adminIpAllowlist,
  adminRateLimiter,
  tenantRoutes
);
app.use('/api/v1/admin', requireRole('ADMIN', 'SUPER_ADMIN'), adminIpAllowlist, adminRateLimiter, adminDashboardRoutes);
app.use('/api/v1/admin/gamification', requireRole('ADMIN', 'SUPER_ADMIN'), adminIpAllowlist, adminRateLimiter, adminGamificationRoutes);

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
app.use('/api/v1/theatre', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'OT_STAFF'), orBoardRoutes);
app.use('/api/v1/anesthesia', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'OT_STAFF'), phiAccessLogger('ANESTHESIA_CHART'), anesthesiaChartRoutes);
app.use('/api/v1/microbiology', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'LAB_STAFF'), phiAccessLogger('MICROBIOLOGY'), microbiologyRoutes);
app.use('/api/v1/pcpndt', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'RADIOLOGIST'), phiAccessLogger('PCPNDT'), pcpndtRoutes);
app.use('/api/v1/icu', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'ICU_STAFF'), phiAccessLogger('ICU'), icuRoutes);
app.use('/api/v1/compliance', requireRole('ADMIN', 'SUPER_ADMIN', 'PHARMACIST', 'NURSING_STAFF', 'COMPLIANCE_OFFICER'), phiAccessLogger('COMPLIANCE_BMW_DRUG_RETURNS'), bmwAndDrugReturnRoutes);
app.use('/api/v1/death-certification', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF'), phiAccessLogger('DEATH_CERTIFICATION'), deathCertificationRoutes);
app.use('/api/v1/dialysis', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'DIALYSIS_TECHNICIAN'), phiAccessLogger('DIALYSIS'), dialysisRoutes);

// Blood Bank
app.use('/api/v1/blood-bank', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'BLOOD_BANK_STAFF'), phiAccessLogger('BLOOD_BANK'), bloodBankRoutes);

// Billing & Invoicing (mount-level role gate + route-level checks for mutations)
app.use('/api/v1/billing', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'BILLING_STAFF', 'PATIENT'), billingRoutes);
app.use('/api/v1/billing/v2', requireRole('ADMIN', 'SUPER_ADMIN', 'BILLING_STAFF', 'BILLING_INCHARGE', 'FINANCE_INCHARGE', 'NURSING_STAFF', 'DOCTOR'), billingV2Routes);
app.use('/api/v1/billing', requireRole('ADMIN', 'SUPER_ADMIN', 'BILLING_STAFF', 'INSURANCE_COORDINATOR'), revenueCycleRoutes);
app.use('/api/v1/lab', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'LAB_STAFF'), phiAccessLogger('LAB_RESULT'), labRoutes);
// A5 — structured panel entry + reference-range admin (sibling router under same /lab prefix).
app.use('/api/v1/lab', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'LAB_STAFF'), phiAccessLogger('LAB_RESULT'), labPanelRoutes);
app.use('/api/v1/insurance', requireRole('ADMIN', 'SUPER_ADMIN', 'BILLING_STAFF', 'INSURANCE_COORDINATOR'), insuranceClaimsRoutes);
// Chart-shaped TPA enhancement surface — keyed off admission_id, open
// to clinicians so a treating consultant can initiate an enhancement
// from the patient chart instead of being routed through billing.
// See findings 2026-05-09-...-enhancement-in-billing-not-chart and
// 2026-05-10-...-doctor-enhancement-rbac.
app.use(
  '/api/v1/admissions/:admissionId/tpa-enhancement',
  requireRole(
    'ADMIN', 'SUPER_ADMIN',
    'DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT',
    'NURSING_STAFF',
    'BILLING_STAFF', 'INSURANCE_COORDINATOR',
  ),
  phiAccessLogger('INSURANCE_PREAUTH'),
  admissionEnhancementRoutes,
);
app.use('/api/v1/pmjay', requireRole('ADMIN', 'SUPER_ADMIN', 'BILLING_STAFF', 'INSURANCE_COORDINATOR'), pmjayRoutes);
app.use('/api/v1/maternity', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF'), phiAccessLogger('MATERNITY_RECORD'), maternityRoutes);
// A10 — paediatric immunisation tracking. Receptionists need write access
// to seed a returning child's schedule; doctors + nurses to record doses.
app.use('/api/v1/paediatric', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'RECEPTIONIST'), phiAccessLogger('PAEDIATRIC_IMMUNISATION'), paediatricImmunisationRoutes);
app.use('/api/v1/productivity', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF'), productivityRoutes);
app.use('/api/v1/dashboards', requireRole('ADMIN', 'SUPER_ADMIN'), dashboardsRoutes);
app.use('/api/v1/portal', patientRateLimiter, requireRole('PATIENT'), phiAccessLogger('PATIENT_PORTAL'), patientPortalRoutes);
app.use('/api/v1/patient', patientRateLimiter, requireRole('PATIENT'), phiAccessLogger('PATIENT_PORTAL'), patientPortalRoutes);
app.use('/api/v1/staff-messaging', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'BILLING_STAFF'), phiAccessLogger('PATIENT_MESSAGING'), staffMessagingRoutes);
app.use('/api/v1/discharge-summaries', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF'), phiAccessLogger('DISCHARGE_SUMMARY'), dischargeRoutes);

// Quality & Infection Control (route-level role checks)
app.use('/api/v1/quality', qualityRoutes);

// Referral Management (route-level role checks)
app.use('/api/v1/referrals', phiAccessLogger('REFERRAL'), referralRoutes);

// Inter-staff messaging
app.use('/api/v1/messaging', requireRole('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'LAB_STAFF', 'HR_STAFF', 'GENERAL_STAFF', 'DELIVERY_STAFF', 'RECEPTIONIST'), messagingRoutes);

// Compliance: Breach Notification + Audit Search (admin only)
app.use('/api/v1/compliance', requireRole('ADMIN', 'SUPER_ADMIN'), adminRateLimiter, breachRoutes);
app.use('/api/v1/compliance', requireRole('ADMIN', 'SUPER_ADMIN'), adminRateLimiter, auditSearchRoutes);
app.use('/api/v1/compliance', requireRole('ADMIN', 'SUPER_ADMIN'), adminRateLimiter, complianceIndicatorsRoutes);

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
