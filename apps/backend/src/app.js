// src/app.js
import { initializeSourceMaps } from './config/sourceMapConfig.js';

// Initialize source maps before anything else
initializeSourceMaps();
await import('./utils/sentry.js');

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
import {
  requireDowntimeAccess,
  requireProductionMonitoringAccess,
} from './middleware/infrastructureAccessMiddleware.js';
import { adminIpAllowlist } from './middleware/ipAllowlistMiddleware.js';
import appCheckMiddleware from './middleware/appCheckMiddleware.js';
import { specialtyDepartmentGuard } from './middleware/specialtyDepartmentMiddleware.js';
import jwtAuth, { enforceFullScope } from './middleware/jwtMiddleware.js';
import tenantContextMiddleware from './middleware/tenantContextMiddleware.js';
import tenantRlsMiddleware from './middleware/tenantRlsMiddleware.js';
import tenantRoutes from './routes/admin/tenantRoutes.js';
import tenantContextRoutes from './routes/admin/tenantContextRoutes.js';
import loggingMiddleware from './middleware/loggingMiddleware.js';
import { normalizeIdentityFields } from './middleware/normalizeIdentityFields.js';
import { billingPhiAccessLogger } from './middleware/billingPhiAccessMiddleware.js';
import { patientAccessGuardForPaths, phiAccessLoggerForPaths } from './middleware/conditionalPhiAccessMiddleware.js';
import { patientAccessGuard, patientAccessGuardForResource, phiAccessLogger } from './middleware/phiAccessMiddleware.js';
import fhirPatientContext, { requireFhirSearchPatientContext } from './middleware/fhirPatientContext.js';
import { prometheusMiddleware } from './middleware/prometheusMiddleware.js';
import {
  patientRateLimiter,
  patientInvestigationRateLimiter,
  genericLimiter,
  getRateLimiter,
  adminRateLimiter,
  dataExportRateLimiter,
  dashboardRateLimiter,
  healthMountRateLimiter
} from './middleware/rateLimitMiddleware.js';
import { requireRole, requireSuperAdminStepUp } from './middleware/rbacMiddleware.js';
import { sanitizeAllBodyStrings } from './middleware/sanitizeMiddleware.js';
import requestIdMiddleware from './middleware/requestIdMiddleware.js';
import { sentryScopeMiddleware } from './middleware/sentryScopeMiddleware.js';
import { selfHealingMiddleware } from './middleware/selfHealingMiddleware.js';
import validateApiKey from './middleware/validateApiKey.js';
import { publicCache } from './middleware/cacheControlMiddleware.js';
import { success, error } from './utils/responseHelper.js';
import { isTrustedIngressProxy } from './utils/trustedProxy.js';
import { isHl7ReceiveEndpoint } from './utils/urlRedaction.js';
import { PATIENT_LOOKUP_ROLES } from './config/patientAccessRoles.js';
import {
  ADMIN_ROUTE_ROLES,
  ADOPTION_ROUTE_ROLES,
  ADMISSION_OCCUPANCY_ROUTE_ROLES,
  ADMISSION_SURFACE_ROUTE_ROLES,
  APPOINTMENT_ROUTE_ROLES,
  ALL_STAFF_MESSAGING_ROUTE_ROLES,
  BED_INSPECTION_ROUTE_ROLES,
  BED_PARENT_ROUTE_ROLES,
  BILLING_ROUTE_ROLES,
  BILLING_V2_ROUTE_ROLES,
  BLOOD_BANK_ROUTE_ROLES,
  BURN_ROUTE_ROLES,
  CATH_LAB_ROUTE_ROLES,
  CARE_PATHWAY_ROUTE_ROLES,
  COLD_CHAIN_ROUTE_ROLES,
  CLINICAL_ASSESSMENT_ROUTE_ROLES,
  CLINICAL_INBOX_ROUTE_ROLES,
  CLINICAL_CONTINUITY_RECONCILIATION_ROUTE_ROLES,
  CLINICAL_STAFF_ROUTE_ROLES,
  COMPLIANCE_ROUTE_ROLES,
  AMBULANCE_TRACKING_ROUTE_ROLES,
  CONSENT_ROUTE_ROLES,
  CSSD_ROUTE_ROLES,
  DELIVERY_ROUTE_ROLES,
  DIETARY_ROUTE_ROLES,
  DIALYSIS_ROUTE_ROLES,
  ED_ROUTE_ROLES,
  EMR_TIMELINE_READ_ROUTE_ROLES,
  ENGAGEMENT_ROUTE_ROLES,
  FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES,
  HOUSEKEEPING_VISIBILITY_ROUTE_ROLES,
  ICU_ROUTE_ROLES,
  INVESTIGATION_ROUTE_ROLES,
  IPD_SUPPORT_ROUTE_ROLES,
  LAB_INGEST_MOUNT_ROUTE_ROLES,
  LAB_ROUTE_ROLES,
  LINEN_LAUNDRY_ROUTE_ROLES,
  MATERNITY_ROUTE_ROLES,
  MICROBIOLOGY_ROUTE_ROLES,
  NURSING_ASSESSMENT_ROUTE_ROLES,
  PAEDIATRIC_ROUTE_ROLES,
  PATIENT_FLOW_ROUTE_ROLES,
  PATHOLOGY_ROUTE_ROLES,
  PCPNDT_ROUTE_ROLES,
  PEOPLE_OPERATIONS_ROUTE_ROLES,
  PHYSIO_ROUTE_ROLES,
  PHARMACY_ROUTE_ROLES,
  PHARMACY_ORDER_ROUTE_ROLES,
  PHARMACY_SUPPLY_ROUTE_ROLES,
  RADIOLOGY_ROUTE_ROLES,
  RECORD_ROUTE_ROLES,
  STAFF_PATIENT_MESSAGING_ROUTE_ROLES,
  STEMI_ROUTE_ROLES,
  STROKE_ROUTE_ROLES,
  TECHNICAL_ADMIN_ROUTE_ROLES,
  THEATRE_ROUTE_ROLES,
  VIRTUAL_WARD_ROUTE_ROLES,
} from './config/routeRolePolicy.js';

// ====================================
// ROUTE IMPORTS - Organized by category
// ====================================

// Public / mixed modules
import { callbackRouter as abdmCallbackRoutes, patientRouter as abdmPatientRoutes } from './routes/abdm/abdmRoutes.js';
import { abdmEnrolmentPortalRouter, abdmEnrolmentStaffRouter } from './routes/abdm/abdmEnrolmentRoutes.js';
import abdmShareIntakeRoutes from './routes/abdm/abdmShareIntakeRoutes.js';
import abdmHiuRoutes from './routes/abdm/abdmHiuRoutes.js';
import { callbackRouter as uhiCallbackRoutes, adminRouter as uhiAdminRoutes } from './routes/uhi/uhiRoutes.js';
import adoptionRoutes from './routes/adoption/adoptionRoutes.js';
import { callbackRouter as nhcxCallbackRoutes } from './routes/nhcx/nhcxCallbackRoutes.js';
import interfaceEngineIngressRoutes from './routes/interfaceEngine/interfaceEngineIngressRoutes.js';
import adminDashboardRoutes from './routes/admin/index.js';
import clinicalAiAdminRoutes from './routes/admin/clinicalAiRoutes.js';
import clinicalAiClinicalUseRoutes from './routes/admin/clinicalAi/clinicalUseRoutes.js';
import { CLINICAL_AI_USER_ROLES_LIST } from './routes/admin/clinicalAi/shared.js';
import adminForecastRoutes from './routes/admin/forecastRoutes.js';
import entitlementCapabilityRoutes from './routes/entitlements/capabilityRoutes.js';
// Results-inbox (design §4.5): a DEDICATED minimal 2-endpoint router
// (GET /tasks/inbox + POST /tasks/:id/acknowledge) mounted clinical-staff-gated
// at /api/v1/clinical-inbox so the safety net is reachable by clinicians — WITHOUT
// exposing the rest of the admin tasks/workflow/escalation surface to them.
import clinicalInboxRoutes from './routes/clinicalInboxRoutes.js';
import carePathwayRoutes from './routes/carePathwayRoutes.js';
import appointmentRoutes from './routes/appointment/index.js';
import authRoutes from './routes/auth/index.js';
import otpRoutes from './routes/auth/otpRoutes.js';
import bedManagementRoutes from './routes/bed/bedManagementRoutes.js';
import { bedRouter, wardRouter } from './routes/bed/bedRoutes.js';
import bedInspectionRoutes from './routes/bed/bedInspectionRoutes.js';
import edRoutesForClinicalStaff from './routes/admin/edRoutes.js';
import ambulanceTrackingRoutes from './routes/ed/ambulanceTrackingRoutes.js';
import facilityAssetRoutes from './routes/facility/facilityAssetRoutes.js';
import ipdSupportRoutes from './routes/ipd/ipdSupportRoutes.js';
import auditSearchRoutes from './routes/compliance/auditSearchRoutes.js';
import breachRoutes from './routes/compliance/breachRoutes.js';
import complianceIndicatorsRoutes from './routes/compliance/indicatorsRoutes.js';
import configRoutes from './routes/configRoutes.js';
import dashboardRoutes from './routes/dashboard/index.js';
import deliveryRoutes from './routes/delivery/index.js';
import departmentRoutes from './routes/department/index.js';
import { getDepartmentsWithDoctors } from './controllers/department/departmentController.js';
import { markRouterDomain } from './config/openapiDomain.js';
import deviceRoutes from './routes/deviceRoutes.js';
import { coldChainRoutes, coldChainIngestRoutes } from './routes/coldChainRoutes.js';
import doctorRoutes from './routes/doctor/index.js';
import feedbackRoutes from './routes/feedbackRoutes.js';
import healthRoutes from './routes/health/index.js';
import uptimeRoutes from './routes/health/uptimeRoutes.js';
import realtimeRoutes from './routes/realtime/realtimeRoutes.js';
import realtimeTicketRoutes from './routes/realtime/realtimeTicketRoutes.js';
import chatbotRoutes from './routes/chatbot/chatbotRoutes.js';
import infrastructureRoutes from './routes/infrastructure/index.js';
import investigationRoutes from './routes/investigation/index.js';
import logRoutes from './routes/logs/index.js';
import notificationRoutes from './routes/notification/index.js';
import engagementRoutes from './routes/engagement/engagementRoutes.js';
import patientSearchRoutes from './routes/patient/patientSearchRoutes.js';
import patientFlowRoutes from './routes/patientFlow/kioskCheckinRoutes.js';
import pharmacyRoutes from './routes/pharmacy/index.js';
import {
  COUNTER_SALE_APPROVAL_HOST_ROLES,
  pharmacyCounterSaleWitnessApprovalRoutes,
} from './routes/pharmacy/counterSaleRoutes.js';
import {
  SUBSTITUTION_WITNESS_APPROVAL_HOST_ROLES,
  pharmacySubstitutionWitnessApprovalRoutes,
} from './routes/pharmacy/dispenseSubstitutionWitnessRoutes.js';
import pharmacyInventoryV2Routes, {
  pharmacyInventoryMovementWitnessApprovalRoutes,
  pharmacyInventoryWitnessApprovalRoutes,
  PHARMACY_CONTROLLED_DISPENSE_WITNESS_ROLES,
} from './routes/pharmacy/inventoryV2Routes.js';
import pharmacySupplyRoutes from './routes/admin/pharmacySupplyRoutes.js';
import prescriptionRoutes from './routes/prescription/index.js';
import recordRoutes from './routes/record/index.js';
import housekeepingRoutes from './routes/housekeepingRoutes.js';
import linenLaundryRoutes from './routes/linen/linenLaundryRoutes.js';
import searchRoutes from './routes/searchRoutes.js';
import scimRoutes from './routes/scimRoutes.js';
import sosRoutes from './routes/sosRoutes.js';
import staffRoutes from './routes/staff/index.js';
import staffPhoneRoutes from './routes/staff/phoneRoutes.js';
import storageRoutes from './routes/storage/storageRoutes.js';
import uploadRoutes from './routes/upload/uploadRoutes.js';
import userRoutes from './routes/user/index.js';
import patientChatbotRoutes from './routes/patient/chatbotRoutes.js';
import patientVirtualWardRoutes from './routes/patient/virtualWardRoutes.js';

// FHIR interoperability
import fhirRoutes from './routes/fhir/fhirRoutes.js';
import publicSmartFhirRoutes from './routes/smartFhir/publicSmartFhirRoutes.js';
import cdsHooksRoutes from './routes/clinical/cdsHooksRoutes.js';
import encounterRoutes from './routes/clinical/encounterRoutes.js';

// Clinical Document Export & Import
import documentRoutes from './routes/documents/documentRoutes.js';

// HL7v2 messaging — the ingress gate, its rate limiter and the router are
// mounted together by mountHl7Interface(); their ORDER is load-bearing.
import { mountHl7Interface } from './routes/hl7/mountHl7Interface.js';
import { generateACK } from './services/hl7/hl7Parser.js';

// Admin (centralized under /api/v1/admin)

// System settings and logs (admin portal: /api/v1/system/* and /api/v1/logs/*)
import systemRoutes from './routes/system/index.js';

// Patient dashboard (JWT + PATIENT role — see mount in authenticated section)

// Config routes (API key only, no JWT)

// GDPR Data Export + Erasure
import dataExportRoutes from './routes/dataExportRoutes.js';
import gdprRoutes from './routes/gdprRoutes.js';

// HIPAA Consent Management
import consentRoutes from './routes/consentRoutes.js';

// CareTeam ABAC — PHI-access break-glass activation lifecycle (RBAC enforced in route file)
import breakGlassRoutes from './routes/security/breakGlassRoutes.js';

// Session Management (view/revoke active sessions)
import sessionRoutes from './routes/sessionRoutes.js';

// Admin 2FA (TOTP)

// Compliance (Breach Notification + Audit Search)

// ABDM (Ayushman Bharat Digital Mission) Integration

// Billing & Invoicing
import billingRoutes from './routes/billing/billingRoutes.js';
import billingV2Routes from './routes/billing/billingV2Routes.js';
import publicPaymentPageRoutes from './routes/billing/publicPaymentPageRoutes.js';
import paymentGatewayRoutes from './routes/billing/paymentGatewayRoutes.js';
import gstEInvoiceRoutes from './routes/billing/gstEInvoiceRoutes.js';
import paymentGatewayWebhookRoutes from './routes/billing/paymentGatewayWebhookRoutes.js';
import smsDlrWebhookRoutes from './routes/webhooks/smsDlrRoutes.js';
import labRoutes from './routes/lab/labRoutes.js';
import labIngestRoutes from './routes/lab/labIngestRoutes.js';
import insuranceClaimsRoutes from './routes/insurance/claimsRoutes.js';
import admissionEnhancementRoutes from './routes/insurance/admissionEnhancementRoutes.js';
import pmjayRoutes from './routes/insurance/pmjayRoutes.js';
import maternityRoutes from './routes/maternity/maternityRoutes.js';
import productivityRoutes from './routes/productivity/productivityRoutes.js';
import dashboardsRoutes from './routes/dashboards/dashboardsRoutes.js';
import patientPortalRoutes from './routes/portal/patientPortalRoutes.js';
import staffMessagingRoutes from './routes/portal/staffMessagingRoutes.js';
import teleconsultProvisioningRoutes from './routes/telemedicine/teleconsultProvisioningRoutes.js';
import dischargeRoutes from './routes/discharge/dischargeRoutes.js';
import revenueCycleRoutes from './routes/billing/revenueCycleRoutes.js';
import revenueCycleTrackerRoutes from './routes/billing/revenueCycleTrackerRoutes.js';

// Quality & Infection Control
import qualityRoutes from './routes/quality/qualityRoutes.js';

// Referral Management
import referralRoutes from './routes/referral/referralRoutes.js';

// Department modules: Radiology, Dietary, Operating Theatre, Blood Bank
import radiologyRoutes from './routes/radiology/radiologyRoutes.js';
import pathologyRoutes from './routes/pathology/pathologyRoutes.js';
import dietaryRoutes from './routes/dietary/dietaryRoutes.js';
import theatreRoutes from './routes/theatre/theatreRoutes.js';
import orBoardRoutes from './routes/theatre/orBoardRoutes.js';
import anesthesiaChartRoutes from './routes/theatre/anesthesiaChartRoutes.js';
import ctvsPerfusionRoutes from './routes/theatre/ctvsPerfusionRoutes.js';
import surgicalDocumentationRoutes from './routes/admin/surgicalDocumentationRoutes.js';
import cssdRoutes from './routes/cssd/cssdRoutes.js';
import microbiologyRoutes from './routes/lab/microbiologyRoutes.js';
import labPanelRoutes from './routes/lab/labPanelRoutes.js';
import labThresholdGovernanceRoutes from './routes/lab/labThresholdGovernanceRoutes.js';
import paediatricImmunisationRoutes from './routes/paediatric/paediatricImmunisationRoutes.js';
import pcpndtRoutes from './routes/compliance/pcpndtRoutes.js';
import bmwAndDrugReturnRoutes from './routes/compliance/bmwAndDrugReturnRoutes.js';
import icuRoutes from './routes/clinical/icuRoutes.js';
import burnRoutes from './routes/clinical/burnRoutes.js';
import strokePathwayRoutes from './routes/clinical/strokePathwayRoutes.js';
import stemiPathwayRoutes from './routes/clinical/stemiPathwayRoutes.js';
import clinicalAlertsRoutes from './routes/clinical/clinicalAlertsRoutes.js';
import resuscitationRoutes from './routes/clinical/resuscitationRoutes.js';
import deathCertificationRoutes from './routes/clinical/deathCertificationRoutes.js';
import birthNotificationRoutes from './routes/clinical/birthNotificationRoutes.js';
import publicHealthRoutes from './routes/publicHealth/publicHealthRoutes.js';
import dialysisRoutes from './routes/clinical/dialysisRoutes.js';
import cathLabRoutes from './routes/clinical/cathLabRoutes.js';
import radiationOncologyRoutes from './routes/clinical/radiationOncologyRoutes.js';
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
import downtimeRoutes from './routes/downtime/downtimeRoutes.js';
import clinicalContinuityPolicyDeliveryRoutes from './routes/downtime/clinicalContinuityPolicyDeliveryRoutes.js';
import clinicalContinuityReconciliationRoutes from './routes/downtime/clinicalContinuityReconciliationRoutes.js';
import clinicalContinuityActivationTransitionRoutes from './routes/downtime/clinicalContinuityActivationTransitionRoutes.js';
import staticDowntimeRoutes from './routes/downtime/staticDowntimeRoutes.js';
import terminologyRoutes from './routes/terminology/terminologyRoutes.js';
import problemListRoutes from './routes/clinical/problemListRoutes.js';
import allergyRoutes from './routes/clinical/allergyRoutes.js';
import drugKbRoutes from './routes/clinical/drugKbRoutes.js';
import bcmaRoutes from './routes/clinical/bcmaRoutes.js';
import medRecRoutes from './routes/clinical/medRecRoutes.js';
import pacsRoutes from './routes/radiology/pacsRoutes.js';
import integrityRoutes from './routes/clinical/integrityRoutes.js';
import hl7FeedRoutes from './routes/hl7/hl7FeedRoutes.js';
import deviceVitalsRoutes from './routes/emr/deviceVitalsRoutes.js';
import schedulingRoutes from './routes/scheduling/schedulingRoutes.js';
import nabhRoutes from './routes/quality/nabhRoutes.js';
import cathQualityRoutes from './routes/quality/cathQualityRoutes.js';
import infectionControlRoutes from './routes/quality/infectionControlRoutes.js';
import credentialingRoutes from './routes/staff/credentialingRoutes.js';
import researchRoutes from './routes/research/researchRoutes.js';
import oncologyRoutes from './routes/oncology/oncologyRoutes.js';
import transplantRoutes from './routes/transplant/transplantRoutes.js';
import dentalRoutes from './routes/clinical/dentalRoutes.js';
import ophthalmologyRoutes from './routes/clinical/ophthalmologyRoutes.js';
import physioRoutes from './routes/clinical/physioRoutes.js';
import resultReleaseRoutes from './routes/lab/resultReleaseRoutes.js';
import structuredDiagnosticReleaseRoutes from './routes/diagnostics/structuredDiagnosticReleaseRoutes.js';

// EMR — Clinical Documentation (SOAP, Progress, Procedure, Discharge, Timeline)
import clinicalNotesRoutes from './routes/emr/clinicalNotesRoutes.js';
import clinicalTimelineRoutes from './routes/emr/clinicalTimelineRoutes.js';

// EMR — ADT (Admission/Discharge/Transfer)
import admissionOccupancyRoutes from './routes/emr/admissionOccupancyRoutes.js';
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
import { resolveTenantForRequest } from './services/tenant/tenantService.js';
import { assertClinicalContinuityActionBindings } from './services/downtime/clinicalContinuityActionBindingRegistry.js';
import { clinicalContinuityActionPolicyMiddleware } from './middleware/clinicalContinuityActionPolicyMiddleware.js';

// ====================================
// ENVIRONMENT AND INITIALIZATION
// ====================================

dotenv.config();
import './utils/validateEnv.js';

// Create Express app
const app = express();
const smartFhirRateLimiter = getRateLimiter('smartFhirOAuth');

function isPublicSmartFhirResourceRequest(req) {
  const path = String(req.path || '');
  if (path === '/metadata') return true;
  const authHeader = req.headers?.authorization || '';
  return /^Bearer\s+vh_access_/i.test(String(authHeader));
}

async function publicSmartFhirTenantContext(req, res, next) {
  try {
    req.tenantId = await resolveTenantForRequest(req);
    return next();
  } catch (err) {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    return res.status(status).json({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error',
        code: status === 400 ? 'invalid' : status === 403 ? 'forbidden' : 'exception',
        diagnostics: status >= 500 ? 'Internal server error' : String(err?.message || 'Tenant context required'),
        details: err?.code ? { text: err.code } : undefined,
      }],
    });
  }
}

const publicSmartFhirResourceRouter = express.Router();
publicSmartFhirResourceRouter.use((req, _res, next) => {
  if (isPublicSmartFhirResourceRequest(req)) return next();
  return next('router');
});
publicSmartFhirResourceRouter.use(
  smartFhirRateLimiter,
  publicSmartFhirTenantContext,
  // Seed the AsyncLocalStorage tenant context (audit / cross-tenant fix): this
  // public SMART-token path is mounted BEFORE the global tenantRlsMiddleware at
  // the authenticated block, so its prisma calls previously ran with no tenant
  // context and the prod auto-setTenant wrap never fired. It only needs
  // req.tenantId, which publicSmartFhirTenantContext sets just above.
  tenantRlsMiddleware,
  fhirPatientContext,
  requireFhirSearchPatientContext,
  phiAccessLogger('FHIR_RESOURCE'),
  fhirRoutes,
);
app.set('trust proxy', isTrustedIngressProxy);

function getCanonicalHttpsOrigin() {
  const configuredOrigin =
    process.env.PUBLIC_BASE_URL ||
    process.env.API_PUBLIC_URL ||
    (process.env.INGRESS_PUBLIC_HOST ? `https://${process.env.INGRESS_PUBLIC_HOST}` : '') ||
    'https://api.vhhealth.app';

  try {
    const parsed = new URL(configuredOrigin);
    if (parsed.protocol !== 'https:') {
      throw new Error('must use https');
    }
    return parsed.origin;
  } catch (err) {
    logger.error(`Invalid production HTTPS redirect origin: ${err.message}`);
    return null;
  }
}

function toSafeRedirectPath(originalUrl) {
  const rawPath = String(originalUrl || '/');
  if (rawPath.startsWith('/') && !rawPath.startsWith('//')) {
    return rawPath;
  }
  return `/${rawPath.replace(/^\/+/, '')}`;
}

const CLINICAL_STAFF_ROLES = CLINICAL_STAFF_ROUTE_ROLES;
const EMR_TIMELINE_READ_ROLES = EMR_TIMELINE_READ_ROUTE_ROLES;
const ADMISSION_SURFACE_ROLES = ADMISSION_SURFACE_ROUTE_ROLES;
const ADMISSION_OCCUPANCY_ROLES = ADMISSION_OCCUPANCY_ROUTE_ROLES;
const CLINICAL_AI_CONTROL_ROLES = TECHNICAL_ADMIN_ROUTE_ROLES;
const ORDER_SET_STUDIO_PARENT_ROLES = [...new Set([...CLINICAL_STAFF_ROLES, 'QUALITY_OFFICER'])];
const ORDER_SET_STUDIO_ACTION_PATH = /^\/api\/v1\/emr\/order-sets\/[^/]+\/(?:new-version|submit|pharmacy-review|approve|reject|retire|rollback)$/;
const isOrderSetStudioRequest = (req) => {
  const path = (req.originalUrl || '').split('?')[0];
  return path === '/api/v1/emr/order-sets/studio'
    || path === '/api/v1/emr/order-sets/studio/settings'
    || path === '/api/v1/emr/order-sets/import'
    || ORDER_SET_STUDIO_ACTION_PATH.test(path);
};
const PHARMACY_INVENTORY_PARENT_ROLES = [
  ...new Set([...PHARMACY_ROUTE_ROLES, ...PHARMACY_SUPPLY_ROUTE_ROLES]),
];

function rewriteAdmissionSurface(req, _res, next) {
  const [pathPart, queryPart] = req.url.split('?');
  const query = queryPart ? `?${queryPart}` : '';
  const path = (pathPart || '/').replace(/\/+$/, '') || '/';

  if (path === '/') {
    req.url = req.method === 'POST' ? `/admit${query}` : `/admissions${query}`;
  } else if (path === '/stats') {
    req.url = `/admissions/stats${query}`;
  } else if (path === '/advise') {
    // OPD→IPD bridge alias. The canonical route is
    // POST /api/v1/emr/admissions/advise; this rewrite also exposes it
    // at POST /api/v1/admissions/advise so receptionist tooling can find
    // it under the public admissions surface. Finding:
    // 2026-05-17-inpatient-admission-receptionist-30bd3752.
    req.url = `/admissions/advise${query}`;
  } else if (path.startsWith('/patient/')) {
    req.url = `/admissions${path}${query}`;
  } else if (/^\/\d+$/.test(path)) {
    req.url = `/admission${path}${query}`;
  } else {
    req.url = `${path}${query}`;
  }

  next();
}

const admissionAliasRouter = express.Router();
admissionAliasRouter.use(rewriteAdmissionSurface);
admissionAliasRouter.use(admissionRoutes);

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
      const canonicalOrigin = getCanonicalHttpsOrigin();
      if (!canonicalOrigin) {
        return res.status(500).json({
          success: false,
          message: 'Production HTTPS redirect origin is not configured',
        });
      }
      return res.redirect(301, `${canonicalOrigin}${toSafeRedirectPath(req.originalUrl || req.url)}`);
    }
    next();
  });
}

app.use(compression({ threshold: 1024 })); // Only compress responses > 1KB
app.use(requestIdMiddleware);
app.use(sentryScopeMiddleware);
app.use(apiVersionMiddleware);
// JSON/urlencoded body limit. Driven by HTTP_BODY_LIMIT (the configmap already
// declared this as an app-read value) with a conservative 1mb default — large
// JSON parsing is a CPU-bound DoS surface, and the only legitimately large
// bodies (file uploads) go through multer, NOT express.json. Operators tune
// this knob explicitly; the ingress proxy-body-size (50m) covers multipart
// uploads separately. Registered in validateEnv.js.
const HTTP_BODY_LIMIT = process.env.HTTP_BODY_LIMIT || '1mb';
function bodyLimitBytes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!match) return null;
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Math.floor(Number(match[1]) * units[(match[2] || 'b').toLowerCase()]);
}
const LEGACY_JSON_LIMIT_BYTES = bodyLimitBytes(HTTP_BODY_LIMIT);
// I03 recovery retains up to 2,000,000 decoded UTF-8 message bytes. A JSON
// string can represent one input byte as a six-byte Unicode escape, so this
// endpoint gets a parser that covers worst-case encoding overhead while the
// recovery service enforces the exact decoded-byte ceiling. An operator's
// larger legacy limit remains authoritative; for smaller limits, the verify
// gate retains that boundary for every envelope-less request.
const I03_RECOVERY_ENCODED_JSON_LIMIT_BYTES = 12_100_000;
const HL7_RECEIVE_JSON_LIMIT_BYTES = Math.max(
  LEGACY_JSON_LIMIT_BYTES ?? 0,
  I03_RECOVERY_ENCODED_JSON_LIMIT_BYTES,
);
function captureJsonRawBody(req, body) {
  const path = String(req.originalUrl || req.url || '');
  if (path.startsWith('/api/v1/scim/v2/')) {
    req.scimRawBody = Buffer.from(body);
  }
  if (path === '/api/v1/abdm/consent/on-notify'
      || path === '/api/v1/abdm/health-info/on-request'
      // ABDM completion (migrations 701-703): Scan & Share + thin-HIU
      // callbacks verify the HMAC over these EXACT bytes. Every entry in
      // ABDM_CALLBACK_PATHS (abdmRoutes.js) must appear here with the
      // /api/v1/abdm mount prefix.
      || path === '/api/v1/abdm/patients/profile/share'
      || path === '/api/v1/abdm/hiu/consent-requests/on-init'
      || path === '/api/v1/abdm/hiu/consents/notify'
      || path === '/api/v1/abdm/hiu/health-info/on-request'
      || path === '/api/v1/abdm/hiu/health-info/push') {
    req.abdmRawBody = Buffer.from(body);
  }
  // Payment gateway webhooks are HMAC-signed over the EXACT raw bytes —
  // express.json re-serialization is not byte-stable, so the router verifies
  // against this captured buffer (paymentGatewayWebhookRoutes).
  if (path.startsWith('/webhooks/payments/')) {
    req.paymentGatewayRawBody = Buffer.from(body);
  }
  // UHI webhook legs (migration 705): the beckn ed25519 signature covers a
  // BLAKE-512 digest of these EXACT bytes. Every entry in UHI_CALLBACK_PATHS
  // (uhiRoutes.js) must appear here with the /api/v1/uhi mount prefix.
  if (path === '/api/v1/uhi/search'
      || path === '/api/v1/uhi/init'
      || path === '/api/v1/uhi/confirm'
      || path === '/api/v1/uhi/status'
      || path === '/api/v1/uhi/cancel') {
    req.uhiRawBody = Buffer.from(body);
  }
}

function legacyBodyLimitError(length) {
  const err = new Error('request entity too large');
  err.status = 413;
  err.statusCode = 413;
  err.type = 'entity.too.large';
  err.limit = LEGACY_JSON_LIMIT_BYTES;
  err.length = length;
  return err;
}

const legacyJsonParser = express.json({
  limit: HTTP_BODY_LIMIT,
  verify: (req, _res, body) => captureJsonRawBody(req, body),
});
const hl7ReceiveJsonParser = express.json({
  limit: HL7_RECEIVE_JSON_LIMIT_BYTES,
  verify: (req, _res, body) => {
    let parsedBody;
    try {
      parsedBody = JSON.parse(body.toString('utf8'));
    } catch {
      if (LEGACY_JSON_LIMIT_BYTES !== null && body.length > LEGACY_JSON_LIMIT_BYTES) {
        throw legacyBodyLimitError(body.length);
      }
      return;
    }

    const hasRecovery = parsedBody
      && typeof parsedBody === 'object'
      && !Array.isArray(parsedBody)
      && Object.prototype.hasOwnProperty.call(parsedBody, 'recovery');
    if (hasRecovery) {
      req.hl7InboundRecoveryRequest = true;
      return;
    }
    if (LEGACY_JSON_LIMIT_BYTES !== null && body.length > LEGACY_JSON_LIMIT_BYTES) {
      throw legacyBodyLimitError(body.length);
    }
  },
});
app.use((req, res, next) => {
  const parser = isHl7ReceiveEndpoint(String(req.originalUrl || req.url || ''))
    ? hl7ReceiveJsonParser
    : legacyJsonParser;
  return parser(req, res, next);
});
const rawHl7RecoveryResponses = middleware => (req, res, next) => {
  if (req.hl7InboundRecoveryRequest !== true) return middleware(req, res, next);
  const originalJson = res.json;
  const restoreAndNext = (err) => {
    res.json = originalJson;
    return next(err);
  };
  res.json = function sendRawHl7PreparseRejection() {
    res.json = originalJson;
    const status = Number(res.statusCode) || 500;
    const ackCode = status >= 500 || status === 429 ? 'AE' : 'AR';
    res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
    return res.send(generateACK('UNKNOWN', ackCode, 'HL7 receive request rejected'));
  };
  try {
    const pending = middleware(req, res, restoreAndNext);
    if (pending && typeof pending.catch === 'function') pending.catch(restoreAndNext);
    return pending;
  } catch (err) {
    return restoreAndNext(err);
  }
};
app.use(express.urlencoded({ limit: HTTP_BODY_LIMIT, extended: true }));
app.use(corsMiddleware);

// Logging
app.use(loggingMiddleware);
app.use(logger.morganMiddleware);

// User context middleware (Sentry req.user + request context) is mounted
// AFTER jwtAuth / tenantContextMiddleware below — at this point req.user and
// req.tenantId do not exist yet, so attaching here made Sentry.setUser a no-op
// (audit §5 reliability). See the app.use(attachUserContext) past jwtAuth.

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
// Rate-limit public endpoints to prevent abuse/recon.
//
// TRAP (finding 2026-08-14, backend-HTTP P2): `genericLimiter` here and on the
// root probes below was a provable NO-OP. Express strips the mount prefix, so
// the limiter guarding `/metrics` (whose router serves GET '/') and the root
// `GET /` handler both observe `req.path === '/'` — which the default
// profile's built-in skip() exempts alongside /health and /api-docs. Same trap
// mountHl7Interface.js / hl7IngressRateLimit.js document for the HL7 bridge;
// same escape hatch: `enforceOnMatchedPath` disables the path-based skip for a
// limiter that is only ever mounted on the exact paths it must guard. A
// dedicated store prefix keeps probe traffic out of the shared default bucket
// namespace.
//
// FOLLOW-UP (finding 2026-08-15): the limiter now fires, but it was built from
// the wrong profile and the wrong key. `default` is the generic API bucket,
// derived from the blanket RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX knobs that
// prod sets to 900000/100 — 100 requests per 15 minutes for ALL probe traffic
// combined — and every Prometheus scrape in the fleet collapsed into one
// cluster-wide Redis bucket (single static Bearer, no x-api-key, mount ahead
// of auth), so 3-10 replicas x 2 Prometheus HA replicas x 30 scrapes/window =
// 180-600 requests into a bucket of 100. Monitoring went blind hardest during
// scale-up, i.e. during an incident. Fixed by a dedicated per-surface `probe`
// profile (see rateLimitProfiles.js for the full scrape arithmetic) mounted
// `instanceScoped` so the budget is per pod and therefore invariant to replica
// count. /metrics is deliberately NOT exempted — it shares the profile.
const probeLimiter = getRateLimiter('probe', {
  enforceOnMatchedPath: true,
  instanceScoped: true,
  storePrefix: 'rl:probe:',
});
app.use('/metrics', probeLimiter, requireProductionMonitoringAccess, metricsRoutes);

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
app.get('/', probeLimiter, async (req, res, next) => {
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
// HEAD / previously had NO limiter at all — same DB probe cost as GET /
// (probeDb runs a real query), so it shares the enforced probe bucket.
app.head('/', probeLimiter, async (req, res, next) => {
  try {
    res.status((await probeDb()) ? 200 : 503).end();
  } catch (err) {
    next(err);
  }
});

// Public API routes
// The patient Firebase exchange and the legacy DB-OTP login (which mints the
// same PATIENT JWT) are app-facing pre-API-key entry points — both run App
// Check in report mode. Keep admin/staff SSO callbacks and the non-login OTP
// utilities outside this scope: browser/provider callbacks cannot attach an
// App Check header.
app.use('/api/v1/auth', patientRateLimiter);
app.use('/api/v1/auth/firebase', appCheckMiddleware({ expectedClient: 'patient' }));
app.use('/api/v1/auth/request-otp', appCheckMiddleware({ expectedClient: 'patient' }));
app.use('/api/v1/auth/verify-otp', appCheckMiddleware({ expectedClient: 'patient' }));
app.use('/api/v1/auth', authRoutes); // Patient, staff, and admin authentication
app.use('/api/v1/otp', patientRateLimiter, otpRoutes);
app.use('/api/v1/health', genericLimiter, healthRoutes);
// NOTE: the realtime channel-catalog/health router (realtimeRoutes) is
// mounted BELOW, behind validateApiKey + jwtAuth, next to the ticket
// exchange. It used to sit here pre-API-key, disclosing the full channel
// catalog and the live connection count to unauthenticated callers
// (2026-08-14 findings, backend-HTTP P3 #7). No client consumes those two
// endpoints pre-auth; the WS transport itself (/ws) is unaffected.
// SCIM is provisioning, not user authentication. It resolves the tenant/provider
// from the URL and verifies its own bearer token before any API-key/JWT middleware.
//
// 873-F3: dedicated fail-closed profile, keyed by SOURCE IP (`keyMode: 'ip'`).
// The generic limiter's defaultKeyGenerator buckets bearer requests per
// sha256(token) — sound only for VERIFIED tokens; here every guessed
// provisioning bearer minted its own fresh bucket, so brute-force was
// effectively unmetered even with Redis healthy. Caps + rationale documented
// on the `scimProvisioning` profile (rateLimitProfiles.js).
const scimRateLimiter = getRateLimiter('scimProvisioning', { keyMode: 'ip' });
app.use('/api/v1/scim/v2', scimRateLimiter, scimRoutes);

// ABDM gateway callbacks (public — no JWT/API key, validated via ABDM request signature)
app.use('/api/v1/abdm', abdmCallbackRoutes);
// UHI network webhooks (public — no JWT/API key; beckn ed25519 signature over
// the captured raw bytes, fail-closed per-tenant resolution, env + tenant
// kill switches default OFF). Pre-RLS mount: every write inside carries an
// explicit tenant_id.
app.use('/api/v1/uhi', uhiCallbackRoutes);
// NHCX gateway callbacks (public — no JWT/API key, tenant-scoped signed callback)
app.use('/api/v1/integrations/nhcx', nhcxCallbackRoutes);
// NL11-S11 interface-engine ingress (public connector, HMAC-signed per tenant/channel).
// 873-F3: pre-auth signature-verification CPU rides a dedicated FAIL-CLOSED
// profile keyed by source IP — sending engines spool and retry, so an honest
// 429 during a store outage is recoverable, while unmetered HMAC verification
// is not. See `interfaceEngineIngress` in rateLimitProfiles.js.
const interfaceEngineRateLimiter = getRateLimiter('interfaceEngineIngress', { keyMode: 'ip' });
app.use('/api/v1/interface-engine', interfaceEngineRateLimiter, interfaceEngineIngressRoutes);

// ====================================
// PUBLIC HEALTH CHECK (no auth required — for Render/uptime monitors)
// ====================================
app.get('/health', (req, res) => success(res, { status: 'ok', service: 'vh-health-backend' }));
app.get('/api/health', (req, res) => success(res, { status: 'ok', service: 'vh-health-backend' }));
// TRAP (P1 finding 2026-08-15, 873-F1) — same prefix-strip as the /metrics
// mount above: `app.use('/health', ...)` makes the limiter observe
// `req.path === '/ready'` / `'/live'`, so the default profile's built-in
// `startsWith('/health')` skip NEVER matched and the k8s probes were metered
// in the shared `t:default:127.0.0.1` bucket — 3 replicas x 12 probe hits/min
// vs prod's 100/15min `default` cap = every pod NotReady for ~12 of each 15
// minutes (deployment.yaml readiness treats a 429 as a probe failure).
// healthMountRateLimiter routes exactly those two mount-relative probe paths
// through the per-pod `probe` profile (still metered, sized for probe
// cadence, fail-open under store loss); every other /health surface keeps the
// generic limiter unchanged.
app.use('/health', healthMountRateLimiter(probeLimiter, genericLimiter), uptimeRoutes);

// Public SMART-on-FHIR launch + token endpoints, plus a SMART-token-only FHIR
// resource path. Platform JWT FHIR traffic falls through to the authenticated
// staff mount below.
app.use('/api/v1/fhir', smartFhirRateLimiter, publicSmartFhirRoutes);
app.use('/api/v1/fhir', publicSmartFhirResourceRouter);

// ====================================
// DB-FREE STATIC DOWNTIME MIRROR (WS2 / REL-5)
// ====================================
// Static, pre-rendered ward-pack HTML served straight off the mirror dir so
// packs stay reachable when the DB/auth layer is DOWN — this is mounted BEFORE
// validateApiKey and jwtAuth on purpose (an outage takes those down too). It
// reads ONLY the filesystem, never prisma. Packs contain PHI, so it mirrors the
// /metrics posture: token-gated + rate-limited, ALWAYS-ON (no NODE_ENV bypass).
// CAN-054: it uses a DEDICATED downtime token (requireDowntimeAccess) rather
// than the shared monitoring token, so a leaked metrics/scrape token can NOT
// also unlock PHI ward packs. Missing dedicated-token configuration fails
// closed; monitoring credentials never authorize this route. It cannot
// DB-audit during an outage, so access is Winston-file logged inside the router
// instead.
// 873-F3: metered under the clinicalContinuityPolicyDelivery profile rather
// than `default` — downtime packs are precisely the surface that must keep
// working while infrastructure (including Redis) is failing, and that
// profile's fail-open posture carries exactly that rationale on the record
// (rateLimitStoreLossPolicy.js). Dedicated store prefix so ward-pack fetches
// never share buckets with the policy-delivery endpoints.
app.use(
  '/downtime/static',
  getRateLimiter('clinicalContinuityPolicyDelivery', { storePrefix: 'rl:downtimeStatic:' }),
  requireDowntimeAccess,
  staticDowntimeRoutes
);

// ====================================
// PUBLIC PAYMENT LANDING PAGE (audit F8)
// ====================================
// The bill-payment URL we already SMS/WhatsApp/email to patients
// (`${HOSPITAL_PAY_BASE_URL}/<token>` — paymentLinkService.sendPaymentLink).
// Mounted BEFORE validateApiKey and jwtAuth because the recipient is a patient
// in a mobile browser holding no credential but the token in the URL; the
// token itself is the capability. It is a browser page, not a JSON API, so it
// renders HTML rather than the success()/error() envelope. Rate-limited with
// the patient profile — that limiter is the anti-enumeration control, and the
// router answers unknown and malformed tokens with one identical page.
app.use('/pay', patientRateLimiter, publicPaymentPageRoutes);

// ====================================
// PAYMENT GATEWAY PROVIDER WEBHOOKS (public, provider-signature-authenticated)
// ====================================
// Razorpay-shaped webhook deliveries carry no VH credential — authenticity is
// the HMAC-SHA256 signature over the raw body, verified against the tenant's
// encrypted webhook secret. The URL's opaque token resolves the tenant
// FAIL-CLOSED (unknown token → 404, nothing written) — this is a pre-RLS
// mount, so the handler writes tenant_id explicitly on every row (migration
// 695 contract). Raw body is captured by the express.json verify hook above.
app.use('/webhooks/payments', genericLimiter, paymentGatewayWebhookRoutes);

// ====================================
// SMS DELIVERY-STATUS (DLR) WEBHOOKS (public, token/signature-authenticated)
// ====================================
// MSG91/Twilio delivery-status callbacks carry no VH credential — the URL's
// bearer token resolves the tenant FAIL-CLOSED via its SHA-256 hash on
// sms_provider_configs (699); unknown token → 401, nothing written, never a
// default tenant. Twilio deliveries are additionally verified against
// X-Twilio-Signature (URL + sorted params, so no raw-body capture needed).
// Receipts land append-only in the 609 ledger inside setTenant; outbox
// status is NEVER flipped from a DLR (migration 700 contract).
app.use('/webhooks/sms', genericLimiter, smsDlrWebhookRoutes);

// ====================================
// API KEY & AUTH MIDDLEWARE
// Apply to all routes below this point
// ====================================

app.use(rawHl7RecoveryResponses(validateApiKey));

// Firebase App Check verification — mounted right after validateApiKey so
// req.apiClient is populated; the patient/staff apiClient filter is what
// exempts every integration/admin surface (SCIM, HL7, ABDM, NHCX,
// interface-engine, cold-chain ingest, admin portal) from App Check.
app.use(appCheckMiddleware());

// Infrastructure routes (debug, swagger, version, rbac) — require API key.
// In production each infra sub-mount additionally requires an admin-tier JWT;
// that gate lives INSIDE routes/infrastructure/index.js, scoped per sub-path.
// It must NEVER ride this '/api/v1' prefix mount: a middleware placed here
// runs for every /api/v1/* request regardless of whether the router matches,
// which in production denied every non-admin role on the ENTIRE API while
// dev/test (where the gate no-ops) stayed green — dalekdefender 2026-08-21.
app.use('/api/v1', infrastructureRoutes);

// ====================================
// API KEY ONLY ROUTES (no JWT required)
// Mount before global JWT auth so Flutter can call these without a JWT
// ====================================

// Patient dashboard — moved behind jwtAuth (see mount below). It previously
// sat here (API-key-only) and disclosed PHI for any phone number — audit
// finding H1 (2026-06-10).

// Campus config — staff app uses API key only for this
app.use('/api/v1/config', configRoutes);

// HL7v2 messaging — mounted before global JWT auth so /receive works with API key only.
// JWT is enforced on /generate within the route file itself.
//
// The INBOUND half is gated on HL7_INBOUND_ENABLED and fails closed. This
// mount used to be unconditional, which made the flag a comment: a deployment
// declaring HL7 ingress off (configmap.yaml sets it "false") still accepted
// signed messages against an active tenant_interop_secrets row or a retained
// legacy HL7_INBOUND_SHARED_SECRET. The gate is repeated inside the router and
// again at the credential boundary — see routes/hl7/hl7InboundIngressGate.js.
// Only /receive is gated: /generate is outbound export and /capability is
// static metadata, neither of which is ingress.
//
// The rate limiter MUST precede the gate: the gate answers before hl7Routes is
// reached, so the router's own limiter never ran on a refused request and a
// disabled /receive was an un-rate-limited 403 sink that also emitted a warn
// line per request. All three statements therefore live together in
// mountHl7Interface() — the mount ORDER is the security property (including
// WHICH path the limiter is mounted at), and a test drives that function
// directly rather than a hand-copied approximation of these lines.
mountHl7Interface(app);
app.use('/api/v1/ingest/cold-chain', coldChainIngestRoutes);

// Guest patient directory: the login/dashboard UI exposes Departments before a
// patient JWT exists. Keep this exact read-only surface API-key-only while the
// broader department router below remains behind jwtAuth.
// On its own router only so it can declare its OpenAPI domain: a route
// registered directly on the app gives the generator no route MODULE to derive
// a tag from (app.js is not under src/routes/), so it fell through to the URL
// and published a stray plural `departments` next to the real `department` tag.
// Mounted at the full path with a '/' route, so the URL is unchanged and no
// other /api/v1/departments request enters this router.
const guestDepartmentDirectoryRoutes = markRouterDomain(express.Router(), 'department');
guestDepartmentDirectoryRoutes.get('/', publicCache(300), getDepartmentsWithDoctors);
app.use('/api/v1/departments/departments-with-doctors', guestDepartmentDirectoryRoutes);

app.use(jwtAuth);  // Single JWT middleware for all authenticated routes
// Narrow-scope tokens (e.g. mfa_setup) must never reach non-auth routes.
// The two setup-enroll/confirm endpoints are mounted under /api/v1/auth
// (above this line) and carry their own requireSetupScope guard; every
// route past this line gets the inverse guard.
app.use(enforceFullScope);
app.use(tenantContextMiddleware);  // Resolves req.tenantId after JWT auth
app.use(tenantRlsMiddleware);      // Phase-2: seed AsyncLocalStorage so prisma auto-applies setTenant when AUTH_ENFORCE_TENANT_RLS=true
app.use(normalizeIdentityFields); // runs AFTER JWT auth
// Sentry user/request context — mounted HERE (not before jwtAuth) so req.user
// and req.tenantId are populated; otherwise Sentry.setUser was always a no-op
// (audit §5 reliability). Authenticated routes are the ones whose errors we
// most need attributed to a user; public/pre-auth routes still get the
// per-request tags from sentryScopeMiddleware mounted at the top of the chain.
app.use(attachUserContext);
app.use(clinicalContinuityActionPolicyMiddleware);

// Entitlement capability manifest for authenticated clients. Clinical/mobile
// surfaces stay informational; hard-blocking happens only on opted-in routes.
app.use('/api/v1/entitlements', requireRole(...ALL_STAFF_MESSAGING_ROUTE_ROLES, 'PATIENT'), entitlementCapabilityRoutes);

// ====================================
// AUTHENTICATED ROUTES (API key required)
// ====================================

// Realtime ticket exchange — JWT-authed; issues short-lived WS-scoped tokens
// for browser clients that can't expose their primary JWT to JS.
app.use('/api/v1/realtime', genericLimiter, realtimeTicketRoutes);
// Realtime channel catalog + connection-count health. Documentation/ops
// surface for authenticated clients; moved behind validateApiKey + jwtAuth
// so the channel inventory and live connection count are no longer public
// reconnaissance (2026-08-14 findings, backend-HTTP P3 #7). Disjoint paths
// from the ticket router (/channels, /health vs /ticket).
app.use('/api/v1/realtime', genericLimiter, realtimeRoutes);

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
  requireRole(...VIRTUAL_WARD_ROUTE_ROLES),
  phiAccessLogger('VIRTUAL_WARD_CHECK_IN'),
  patientVirtualWardRoutes
);

// Patient dashboard — JWT + PATIENT role required (fix for audit finding H1).
// The handler derives the phone from the authenticated subject and
// tenant-scopes every query; it never trusts a caller-supplied phone.
app.use(
  '/api/v1/dashboard',
  dashboardRateLimiter,
  requireRole('PATIENT'),
  phiAccessLogger('PATIENT_DASHBOARD'),
  dashboardRoutes
);

// Healthcare services - Modularized
// Mount-level role gate (audit finding H2): the router's old wrapAutoRBAC
// call was dead code, leaving every appointment route open to any
// authenticated user. Staff-only and admin-only sub-routes re-narrow inside
// the router; PATIENT is allowed here for booking/own-data routes.
app.use(
  '/api/v1/appointments',
  patientRateLimiter,
  requireRole(...APPOINTMENT_ROUTE_ROLES),
  phiAccessLogger('APPOINTMENT'),
  appointmentRoutes
);
app.use('/api/v1/records', patientRateLimiter, requireRole(...RECORD_ROUTE_ROLES), patientAccessGuard('MEDICAL_RECORD'), phiAccessLogger('MEDICAL_RECORD'), recordRoutes);
app.use('/api/v1/investigations', patientInvestigationRateLimiter, requireRole(...INVESTIGATION_ROUTE_ROLES), patientAccessGuard('INVESTIGATION', { careTeamModeGoverned: true }), phiAccessLogger('INVESTIGATION'), investigationRoutes);
// Pharmacy inventory and stores/purchase routes are operational supply-chain
// surfaces. Mount them before the broader pharmacy-order router so stores and
// purchase users do not need patient pharmacy-order permissions.
app.use(
  '/api/v1/pharmacy/counter-sales/witness-approvals/:id/approve',
  patientRateLimiter,
  requireRole(...COUNTER_SALE_APPROVAL_HOST_ROLES),
  pharmacyCounterSaleWitnessApprovalRoutes,
);
app.use(
  '/api/v1/pharmacy-orders/counter-sales/witness-approvals/:id/approve',
  patientRateLimiter,
  requireRole(...COUNTER_SALE_APPROVAL_HOST_ROLES),
  pharmacyCounterSaleWitnessApprovalRoutes,
);
app.use(
  '/api/v1/pharmacy/dispense-substitution/witness-approvals/:id/approve',
  patientRateLimiter,
  requireRole(...SUBSTITUTION_WITNESS_APPROVAL_HOST_ROLES),
  pharmacySubstitutionWitnessApprovalRoutes,
);
app.use(
  '/api/v1/pharmacy-orders/dispense-substitution/witness-approvals/:id/approve',
  patientRateLimiter,
  requireRole(...SUBSTITUTION_WITNESS_APPROVAL_HOST_ROLES),
  pharmacySubstitutionWitnessApprovalRoutes,
);
app.use(
  '/api/v1/pharmacy/inventory/v2/controlled-dispense/witness-approvals/:id/approve',
  patientRateLimiter,
  requireRole(...PHARMACY_CONTROLLED_DISPENSE_WITNESS_ROLES),
  pharmacyInventoryWitnessApprovalRoutes,
);
app.use(
  '/api/v1/pharmacy-orders/inventory/v2/controlled-dispense/witness-approvals/:id/approve',
  patientRateLimiter,
  requireRole(...PHARMACY_CONTROLLED_DISPENSE_WITNESS_ROLES),
  pharmacyInventoryWitnessApprovalRoutes,
);
app.use(
  '/api/v1/pharmacy/inventory/v2/movements/witness-approvals/:id/approve',
  patientRateLimiter,
  requireRole(...PHARMACY_CONTROLLED_DISPENSE_WITNESS_ROLES),
  pharmacyInventoryMovementWitnessApprovalRoutes,
);
app.use(
  '/api/v1/pharmacy-orders/inventory/v2/movements/witness-approvals/:id/approve',
  patientRateLimiter,
  requireRole(...PHARMACY_CONTROLLED_DISPENSE_WITNESS_ROLES),
  pharmacyInventoryMovementWitnessApprovalRoutes,
);
app.use('/api/v1/pharmacy/inventory/v2', patientRateLimiter, requireRole(...PHARMACY_INVENTORY_PARENT_ROLES), pharmacyInventoryV2Routes);
app.use('/api/v1/pharmacy-orders/inventory/v2', patientRateLimiter, requireRole(...PHARMACY_INVENTORY_PARENT_ROLES), pharmacyInventoryV2Routes);
app.use('/api/v1/pharmacy-supply', adminRateLimiter, requireRole(...PHARMACY_SUPPLY_ROUTE_ROLES), pharmacySupplyRoutes);

app.use('/api/v1/pharmacy-orders', patientRateLimiter, requireRole(...PHARMACY_ORDER_ROUTE_ROLES), patientAccessGuard('PHARMACY_ORDER', { careTeamModeGoverned: true }), phiAccessLogger('PHARMACY_ORDER'), pharmacyRoutes);
// Alias mount: /api/v1/pharmacy/* → same sub-routes as /api/v1/pharmacy-orders/*.
// The admin /dashboard/pharmacy/inventory page calls /pharmacy/inventory/*
// (summary/low-stock/expiring-soon/expired); the canonical mount at
// /pharmacy-orders/inventory/* still serves existing clients.
app.use('/api/v1/pharmacy', patientRateLimiter, requireRole(...PHARMACY_ORDER_ROUTE_ROLES), patientAccessGuard('PHARMACY_ORDER', { careTeamModeGoverned: true }), phiAccessLogger('PHARMACY_ORDER'), pharmacyRoutes);
app.use('/api/v1/prescriptions', patientRateLimiter, requireRole(...PHARMACY_ORDER_ROUTE_ROLES), patientAccessGuard('PRESCRIPTION', { careTeamModeGoverned: true }), phiAccessLogger('PRESCRIPTION'), prescriptionRoutes);
app.use('/api/v1/delivery', patientRateLimiter, requireRole(...DELIVERY_ROUTE_ROLES), deliveryRoutes);
app.use('/api/v1/patient-flow', patientRateLimiter, requireRole(...PATIENT_FLOW_ROUTE_ROLES), phiAccessLogger('PATIENT_FLOW_CHECKIN'), patientFlowRoutes);
app.use('/api/v1/departments', publicCache(300), departmentRoutes);
app.use('/api/v1/doctors', publicCache(300), doctorRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/adoption', requireRole(...ADOPTION_ROUTE_ROLES), sanitizeAllBodyStrings, adoptionRoutes);
app.use('/api/v1/engagement', requireRole(...ENGAGEMENT_ROUTE_ROLES), sanitizeAllBodyStrings, phiAccessLogger('ENGAGEMENT'), engagementRoutes);
// Staff-side patient lookup (Cmd+K picker and workbench search). Kept
// explicit in config so clinical, front-office, billing, and records access
// stay aligned with PHI governance. Patient self-search isn't applicable.
app.use(
  '/api/v1/patients',
  requireRole(...PATIENT_LOOKUP_ROLES),
  phiAccessLogger('PATIENT_DEMOGRAPHICS'),
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

app.use('/api/v1/feedback', patientRateLimiter, feedbackRoutes);
app.use('/api/v1/sos', patientRateLimiter, sosRoutes);
app.use(
  '/api/v1/search',
  requireRole(...PATIENT_LOOKUP_ROLES),
  phiAccessLogger('PATIENT_SEARCH'),
  searchRoutes,
);

// GDPR Data Export + Erasure. GET /my-data returns the patient's FULL record
// set (appointments, records, investigations, pharmacy, consents…) in one
// response — the single densest PHI read on the platform — so it carries the
// same route-level HIPAA access logging as the sibling PHI mounts above
// (/records, /api/v1/patient). The routes are self-scoped to req.user, so no
// patientAccessGuard is needed.
app.use('/api/v1/data-export', dataExportRateLimiter, phiAccessLogger('DATA_EXPORT'), dataExportRoutes);
app.use('/api/v1/gdpr', dataExportRateLimiter, gdprRoutes);

// Session Management (view/revoke active sessions)
app.use('/api/v1/sessions', sessionRoutes);

// Admin 2FA (TOTP): the live MFA path is adminAuthController (/auth/admin/mfa/*).
// The legacy /auth/admin/totp router was deleted (audit 2026-06-18 §3 Auth) — it
// referenced non-existent columns and minted tokens with a malformed identity.

// HIPAA Consent Management (requires JWT + role check; IDOR enforced in route file)
app.use('/api/v1/consent', requireRole(...CONSENT_ROUTE_ROLES), consentRoutes);

// CareTeam ABAC — PHI-access break-glass activation/revoke/list (RBAC gated to the
// break-glass-eligible roles inside the router via wrapAutoRBAC).
app.use('/api/v1/patient-access/break-glass', breakGlassRoutes);

// ABDM patient-facing routes (JWT required — ABHA registration, consent management).
// /status is excluded — admin/staff connectivity + aggregate-count dashboard,
// no patient-identifying data returned (audit follow-up P14). /register-abha
// is also excluded here — PR #809 (audit follow-up P13) already logs that
// write explicitly via a controller-level logPhiAccess() call, so a
// route-level mount here would double-log every successful link.
const ABDM_PHI_PATHS = [
  '/api/v1/abdm/verify-abha',
  '/api/v1/abdm/patient-by-abha',
  '/api/v1/abdm/consent-requests',
  '/api/v1/abdm/consents',
];
// ABDM completion (migrations 701-703) — mounted BEFORE the generic /abdm
// patient router so the sub-paths resolve deterministically.
//
// Front-desk assisted ABHA enrolment. No route-level PHI logger: every
// enrolment route logs its own logPhiAccess('abha_enrolment') with accurate
// patient attribution (mirrors the /register-abha exclusion above — a mount
// logger would double-log each write).
app.use('/api/v1/abdm/enrolment', abdmEnrolmentStaffRouter);
// Thin HIU. Consent surfaces + session/bundle LISTS ride the route-scoped
// PHI logger; the bundle-CONTENT read is excluded here because the route
// logs it explicitly as 'abdm_hiu_bundle' with patient attribution.
app.use('/api/v1/abdm/hiu', phiAccessLoggerForPaths('ABDM', [
  '/api/v1/abdm/hiu/consent-requests',
  '/api/v1/abdm/hiu/consents',
  /^\/api\/v1\/abdm\/hiu\/sessions(\/\d+(\/bundles)?)?$/,
]), abdmHiuRoutes);
// Scan & Share front-desk work queue — shared demographics are PHI.
app.use('/api/v1/front-desk/abdm/share-intakes', phiAccessLogger('ABDM'), abdmShareIntakeRoutes);
app.use('/api/v1/abdm', phiAccessLoggerForPaths('ABDM', ABDM_PHI_PATHS), abdmPatientRoutes);

// ====================================
// ROLE-PROTECTED ROUTES (JWT enforced globally above)
// ====================================

// Phone self-service (home aggregate + staff queries). Its role gate lives
// INSIDE phoneRoutes.js, scoped to that router's own paths. It must NEVER sit
// on this '/api/v1/staff' mount: Express runs mount middleware for every
// request under the prefix before knowing whether the router matches, so a
// gate here becomes a ceiling over EVERY sibling staff router below and
// silently overrides their broader rbacConfig keys — CMO / CNO /
// MEDICAL_SUPERINTENDENT / ANAESTHETIST and ~20 more roles lost their own
// attendance, leave, payslips and the whole staff-admin console this way
// (2026-08-22 audit; same shape as the #905 '/api/v1' lockout).
app.use('/api/v1/staff', staffPhoneRoutes);
app.use('/api/v1/staff', staffRoutes);

// Housekeeping — top-level canonical surface. Same controller already
// mounted under /api/v1/staff/admin/housekeeping/* and
// /api/v1/staff/hr/housekeeping/* via staff/index.js; this is the
// canonical /api/v1/housekeeping/* path the staff app + admin portal
// expect. Finding:
// 2026-05-09-inpatient-admission-housekeeping-api-routes-absent.
app.use(
  '/api/v1/housekeeping',
  requireRole(...HOUSEKEEPING_VISIBILITY_ROUTE_ROLES),
  housekeepingRoutes,
);

app.use(
  '/api/v1/linen-laundry',
  requireRole(...LINEN_LAUNDRY_ROUTE_ROLES),
  sanitizeAllBodyStrings,
  linenLaundryRoutes,
);

// Bed/Ward management.
//
// Wave-4B-1 — parent gate includes the dedicated HOUSEKEEPING_STAFF role
// so the cleaning team can close the bed-turnover loop via
// POST /:id/ready. Sensitive bed-management endpoints (admit / transfer
// / discharge) re-narrow to clinical roles via per-route requireRole
// guards inside bedManagementRoutes itself. Finding:
//   2026-05-09-inpatient-admission-housekeeping-general-staff-cannot-mark-bed-ready
const BED_PARENT_ROLES = BED_PARENT_ROUTE_ROLES;
app.use('/api/v1/beds', requireRole(...BED_PARENT_ROLES), patientAccessGuard('BED_BOARD', { careTeamModeGoverned: true }), phiAccessLogger('BED_BOARD'), bedRouter);
app.use('/api/v1/beds', requireRole(...BED_PARENT_ROLES), patientAccessGuard('BED_MANAGEMENT', { careTeamModeGoverned: true }), phiAccessLogger('BED_MANAGEMENT'), bedManagementRoutes);
app.use('/api/v1/wards', requireRole(...BED_PARENT_ROLES), patientAccessGuard('WARD_BOARD', { careTeamModeGoverned: true }), phiAccessLogger('WARD_BOARD'), wardRouter);
// D1 — bed inspection / consumer-choice flow. Receptionists need full
// access; admission officers + nursing also; admin for audit.
app.use('/api/v1/bed-inspections', requireRole(...BED_INSPECTION_ROUTE_ROLES), bedInspectionRoutes);

// Emergency department triage — parallel mount at /api/v1/ed for clinical
// staff (NURSING_STAFF in particular). The legacy /api/v1/admin/ed/*
// routes still exist and remain admin-gated for the analytics/reporting
// surface, but the actual triage workflow is a nursing task and must
// not require an ADMIN/SUPER_ADMIN token. See finding
// 2026-05-08-emergency-walk-in-nurse-triage-rbac-blocks-nurses.
app.use(
  '/api/v1/ed',
  requireRole(...ED_ROUTE_ROLES),
  phiAccessLogger('ER_TRIAGE'),
  edRoutesForClinicalStaff,
);

// Ambulance live GPS tracking (migration 683, config-gated per tenant). A
// separate mount because the crew posting fixes (DRIVER /
// EMERGENCY_RESPONDER) is not part of the ED clinical roster that gates
// /api/v1/ed. Position fixes attach to ambulance_requests rows that can
// carry a patient linkage, so the PHI access log covers the surface.
app.use(
  '/api/v1/ambulance',
  requireRole(...AMBULANCE_TRACKING_ROUTE_ROLES),
  phiAccessLogger('AMBULANCE_TRACKING'),
  ambulanceTrackingRoutes,
);

// General (non-biomedical) facility asset register (migration 704). Role
// gates (manage vs read arrays) live in the router; no PHI logger — the
// register has no patient linkage, mutations write ordinary audit_logs rows
// plus the append-only facility_asset_events domain history.
app.use('/api/v1/facility/assets', facilityAssetRoutes);

// IPD support subsystem — advance deposits, attendant passes, ward
// indents (architectural item A4 / migration 174). RBAC is broad
// because the routes file fans out into operations owned by different
// roles (billing for deposits, admission for passes, pharmacy/nursing
// for ward indents); finer-grained per-route requireRole guards live
// in ipdSupportRoutes.js itself (deposit collect vs refund payout,
// pass lifecycle, ward-indent request vs supply sides).
app.use(
  '/api/v1/ipd',
  requireRole(...IPD_SUPPORT_ROUTE_ROLES),
  phiAccessLogger('IPD_SUPPORT'),
  ipdSupportRoutes,
);

// FHIR R4 interoperability — restricted to clinical staff (exposes PHI).
// patientAccessGuard (careTeamModeGoverned → shadow) brings FHIR to parity with
// the other PHI families (nursing-assessments / encounters): today it audits
// care-team ABAC would-be-denials WITHOUT blocking, and the GO_LIVE enforce
// flip then covers FHIR too. fhirPatientContext bridges FHIR's path/query/body
// patient addressing (/Patient/<id>, ?patient=, subject.reference) into
// req.phiContext so the guard can resolve the patient — the generic resolver
// does not recognise FHIR addressing. Audit finding #4.
app.use(
  '/api/v1/fhir',
  requireRole(...FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES),
  fhirPatientContext,
  // CAN-030: deny unscoped PHI collection searches (no ?patient) for non-export
  // roles so FHIR can't be used to enumerate tenant PHI.
  requireFhirSearchPatientContext,
  patientAccessGuard('FHIR_RESOURCE', { careTeamModeGoverned: true }),
  phiAccessLogger('FHIR_RESOURCE'),
  fhirRoutes,
);

// CDS Hooks (https://cds-hooks.org/) — standards-compliant decision-support
// endpoints consumed by external EHR systems. Same RBAC as FHIR since the
// invoke handlers may surface PHI in card detail.
app.use('/api/v1/cds-services', requireRole(...FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES), phiAccessLogger('CDS_HOOKS'), cdsHooksRoutes);

// Clinical Document Export & Import
app.use('/api/v1/documents', requireRole(...FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES), phiAccessLogger('CLINICAL_DOCUMENT'), documentRoutes);

// Clinical workflows: MAR, NEWS2, Nurse Handover
function clinicalParentPatientAccessGuard(req, res, next) {
  if (
    req.method === 'POST'
    && req.path === '/progress-notes'
    && (req.body?.appointment_id || req.body?.appointmentId)
  ) {
    return next();
  }
  return patientAccessGuard('CLINICAL_WORKFLOW')(req, res, next);
}

// sanitizeAllBodyStrings on clinical free-text mounts: audit finding M7 —
// stored-XSS protection previously covered only ~9 route files via opt-in
// field lists; clinical notes/diagnoses/assessments reached storage raw.
app.use('/api/v1/clinical', requireRole(...CLINICAL_STAFF_ROLES), sanitizeAllBodyStrings, clinicalParentPatientAccessGuard, phiAccessLogger('CLINICAL_WORKFLOW'), clinicalRoutes);
app.use('/api/v1/nursing-assessments', requireRole(...NURSING_ASSESSMENT_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('NURSING_ASSESSMENT', { careTeamModeGoverned: true }), phiAccessLogger('NURSING_ASSESSMENT'), nursingAssessmentRoutes);
app.use('/api/v1/encounters', requireRole(...CLINICAL_STAFF_ROLES), sanitizeAllBodyStrings, patientAccessGuard('CLINICAL_ENCOUNTER', { careTeamModeGoverned: true }), phiAccessLogger('CLINICAL_ENCOUNTER'), encounterRoutes);

// Results-inbox safety net (design §4.5) — the per-clinician inbox + acknowledge
// surface, gated to its dedicated clinical audience so every canonical named
// clinician can see and acknowledge their assigned critical-result tasks. This
// mounts a DEDICATED minimal router
// (GET /tasks/inbox + POST /tasks/:id/acknowledge only) — NOT the full admin
// tasks/workflow router — so clinicians cannot read arbitrary tasks by id
// (cross-patient PHI) or mutate/disable escalation rules. The full task surface
// stays ADMIN-only at /api/v1/admin/workflow.
app.use('/api/v1/clinical-inbox', requireRole(...CLINICAL_INBOX_ROUTE_ROLES), phiAccessLogger('CLINICAL_WORKFLOW'), clinicalInboxRoutes);
app.use('/api/v1/care-pathways', requireRole(...CARE_PATHWAY_ROUTE_ROLES), sanitizeAllBodyStrings, phiAccessLogger('CARE_PATHWAY'), carePathwayRoutes);
app.use('/api/v1/burns', requireRole(...BURN_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('BURN_CHART', { careTeamModeGoverned: true }), phiAccessLogger('BURN_CHART'), burnRoutes);

// MAR discoverability aliases — the canonical handlers live at
// /api/v1/clinical/mar/* but ward nurses and the swarm keep probing
// /api/v1/emr/mar/* and /api/v1/nursing/mar/*. The rewrite prepends
// `/mar` so the same router handlers match without duplication. No
// new code, no audit drift — just an extra mount path that points at
// the same controllers. Finding cluster:
//   2026-05-08-inpatient-admission-nurse-blocked-no-mar (cascade)
//   plus repeated probes in driver logs at /emr/mar and /nursing/mar.
function rewriteToMarPrefix(req, _res, next) {
  const [pathPart, queryPart] = req.url.split('?');
  const query = queryPart ? `?${queryPart}` : '';
  const trimmed = (pathPart || '/').replace(/\/+$/, '') || '';
  req.url = `/mar${trimmed}${query}`;
  next();
}
// The OpenAPI generator (scripts/generate-openapi.mjs) SKIPS any mount whose
// handler chain carries this marker. These MAR aliases rewrite req.url at
// runtime (/api/v1/emr/mar/<x> -> /mar/<x>), so the served path differs from
// mount+route — walking them would emit unreachable /emr/mar/mar/* (and
// /nursing/mar/mar/*) artifact paths. The canonical /api/v1/clinical/mar/*
// surface is the contract; these stay as runtime discoverability aliases only.
rewriteToMarPrefix.__openapiSkipMount = true;
app.use(
  '/api/v1/emr/mar',
  requireRole(...CLINICAL_STAFF_ROLES),
  patientAccessGuard('CLINICAL_WORKFLOW'),
  phiAccessLogger('CLINICAL_WORKFLOW'),
  rewriteToMarPrefix,
  clinicalRoutes,
);
app.use(
  '/api/v1/nursing/mar',
  requireRole(...CLINICAL_STAFF_ROLES),
  patientAccessGuard('CLINICAL_WORKFLOW'),
  phiAccessLogger('CLINICAL_WORKFLOW'),
  rewriteToMarPrefix,
  clinicalRoutes,
);

// Clinical assessments: pain / fall-risk / growth-chart (Phase F2)
app.use('/api/v1/clinical/assessments', requireRole(...CLINICAL_ASSESSMENT_ROUTE_ROLES), sanitizeAllBodyStrings, phiAccessLogger('CLINICAL_ASSESSMENT'), clinicalAssessmentRoutes);

// Downtime-mode ward packs (roadmap A3) — scheduled printable census/MAR
// packs for outage operation. PHI by definition → clinical gate + PHI log.
app.use(
  '/api/v1/downtime/reconciliation',
  requireRole(...CLINICAL_CONTINUITY_RECONCILIATION_ROUTE_ROLES),
  phiAccessLogger('DOWNTIME_RECONCILIATION'),
  clinicalContinuityReconciliationRoutes,
);
app.use('/api/v1/downtime', requireRole(...CLINICAL_STAFF_ROLES), phiAccessLogger('DOWNTIME_PACK'), downtimeRoutes);

// Signed policy authority only; no patient or encounter data is present.
app.use(
  '/api/v1/clinical-continuity/activation-transitions',
  requireRole(...ALL_STAFF_MESSAGING_ROUTE_ROLES),
  clinicalContinuityActivationTransitionRoutes
);
app.use(
  '/api/v1/clinical-continuity',
  requireRole(...ALL_STAFF_MESSAGING_ROUTE_ROLES),
  clinicalContinuityPolicyDeliveryRoutes
);

// Terminology service (roadmap B8) — code-system search/validate/map +
// local-catalog bindings. Reference data only (no PHI → no PHI logger).
app.use('/api/v1/terminology', requireRole(...CLINICAL_STAFF_ROLES), terminologyRoutes);

// Longitudinal problem list (roadmap B7) — PHI by definition.
app.use('/api/v1/problems', requireRole(...CLINICAL_STAFF_ROLES), sanitizeAllBodyStrings, patientAccessGuard('PROBLEM_LIST', { careTeamModeGoverned: true }), phiAccessLogger('PROBLEM_LIST'), problemListRoutes);

// Unified allergies (roadmap A10 over HTTP; E5 follow-up) — union of all
// four allergy stores for any patient, admitted or not. PHI by definition.
app.use('/api/v1/allergies', requireRole(...CLINICAL_STAFF_ROLES), sanitizeAllBodyStrings, patientAccessGuard('ALLERGY', { careTeamModeGoverned: true }), phiAccessLogger('ALLERGY'), allergyRoutes);

// Drug knowledge base (roadmap B2) — stateless KB evaluation + source
// status. Reference data; patient-bound screening runs inside
// validatePrescriptionSafety on the prescription write path.
app.use('/api/v1/drug-kb', requireRole(...CLINICAL_STAFF_ROLES), drugKbRoutes);

// BCMA support (roadmap B1) — wristband printing for the bedside scan loop.
// This mount guard does NOT decide who gets a band. Express has not matched the
// route when a mount-level middleware runs, so the :patientUid param is not yet
// in req.params and authorizePatientAccessRequest short-circuits on
// no_patient_context — no policy evaluated, no audit row, in shadow AND in
// enforce (measured: one wristband request writes exactly one
// patient_access_audit_log row, pinned by
// src/tests/bcma-wristband-admin-access.deep.test.js). The authority is
// bcmaRoutes' own guard, which carries PATIENT_WRISTBAND_PRINT — the policy
// holding the owner's 2026-08-25 administrator grant. Giving this line an
// explicit policyCode was tried and reverted: it would have been a control that
// can never fire. The phiAccessLogger below is the part of this chain that does
// real work here (the hipaa_access_log PHI-read row).
app.use('/api/v1/bcma', requireRole(...CLINICAL_STAFF_ROLES), patientAccessGuard('BCMA', { careTeamModeGoverned: true }), phiAccessLogger('BCMA'), bcmaRoutes);

// Medication reconciliation (roadmap B6) — admission/transfer/discharge.
app.use('/api/v1/med-rec', requireRole(...CLINICAL_STAFF_ROLES), sanitizeAllBodyStrings, patientAccessGuard('MED_REC', { careTeamModeGoverned: true }), phiAccessLogger('MED_REC'), medRecRoutes);

// PACS / imaging viewer surface (roadmap B4) — study links, OHIF deep
// links, modality worklist feed.
app.use('/api/v1/pacs', requireRole(...CLINICAL_STAFF_ROLES), patientAccessGuard('RADIOLOGY_PACS', { careTeamModeGoverned: true }), phiAccessLogger('RADIOLOGY_PACS'), pacsRoutes);

// Document integrity (roadmap C4) — e-signatures + audit hash-chain verify.
app.use('/api/v1/integrity', requireRole(...CLINICAL_STAFF_ROLES), phiAccessLogger('DOCUMENT_SIGNATURE'), integrityRoutes);

// Outbound HL7v2 feeds (roadmap C2) — subscriptions + delivery queue.
app.use('/api/v1/hl7-feeds', requireRole(...CLINICAL_STAFF_ROLES), phiAccessLogger('HL7_FEED'), hl7FeedRoutes);

// ICU monitor vitals ingestion + verification queue (roadmap C5).
app.use('/api/v1/devices', requireRole(...CLINICAL_STAFF_ROLES, 'DEVICE_GATEWAY'), phiAccessLogger('DEVICE_VITALS'), deviceVitalsRoutes);
app.use('/api/v1/cold-chain', requireRole(...COLD_CHAIN_ROUTE_ROLES), coldChainRoutes);

// Scheduling optimization (roadmap D2) — templates, slot grids, waitlist,
// bookable resources. Reception works this surface alongside clinicians.
app.use('/api/v1/scheduling', requireRole(...CLINICAL_STAFF_ROLES, 'RECEPTIONIST', 'RECEPTION_INCHARGE', 'ADMISSION_OFFICER'), phiAccessLogger('SCHEDULING'), schedulingRoutes);

// NABH quality indicators (roadmap D4) — computed packs + assessor export.
app.use('/api/v1/quality/nabh', requireRole(...CLINICAL_STAFF_ROLES, 'QUALITY_OFFICER', 'INFECTION_CONTROL_OFFICER', 'CMO', 'CNO', 'MEDICAL_SUPERINTENDENT'), nabhRoutes);

// NL13-P1f cath quality views — dose-audit rollups + complication registry.
// Rides the existing api/v1/quality admin proxy family; registry rows are
// patient-linked, so the mount carries PHI access logging.
app.use('/api/v1/quality/cath', requireRole('ADMIN', ...CLINICAL_STAFF_ROLES, 'QUALITY_OFFICER', 'INFECTION_CONTROL_OFFICER', 'CMO', 'CNO', 'MEDICAL_SUPERINTENDENT'), phiAccessLogger('QUALITY'), cathQualityRoutes);

// Infection-control workbench (roadmap D5) — isolation board, ADT contact
// tracing, antibiogram over existing micro data. Same IC/quality gate as NABH.
app.use('/api/v1/infection-control', requireRole(...CLINICAL_STAFF_ROLES, 'QUALITY_OFFICER', 'INFECTION_CONTROL_OFFICER', 'CMO', 'CNO', 'MEDICAL_SUPERINTENDENT'), phiAccessLogger('INFECTION_CONTROL'), infectionControlRoutes);

// Credentialing & privileging (roadmap D3) — staff PII, no patient PHI.
app.use('/api/v1/credentials', requireRole(...CLINICAL_STAFF_ROLES, 'HR_STAFF', 'QUALITY_OFFICER', 'CMO', 'CNO', 'MEDICAL_SUPERINTENDENT'), credentialingRoutes);

// Research/registry capture (roadmap D6) — CRFs bound to clinical data;
// enrollments/responses are PHI, exports de-identified by default.
// CAN-049: registry enrollments/exports expose subject identity + CRF data;
// add the care-team-governed patient guard as a baseline (study-team membership
// scoping tracked as a follow-up in the service layer).
app.use('/api/v1/research', requireRole(...CLINICAL_STAFF_ROLES, 'QUALITY_OFFICER', 'CMO', 'MEDICAL_SUPERINTENDENT'), patientAccessGuard('CLINICAL_WORKFLOW', { careTeamModeGoverned: true }), phiAccessLogger('RESEARCH'), researchRoutes);

// Oncology/chemo foundations (roadmap D1) — protocols, BSA dosing, cycle
// scheduling, two-person administration verification, cumulative ceilings.
// Patient-owned oncology routes carry child-level patient/resource guards so
// generic :id parameters resolve to the owning patient before the care-team
// decision. Tenant-wide protocols, settings, and operational boards remain
// role-gated without pretending a patient context exists.
app.use('/api/v1/oncology', requireRole(...CLINICAL_STAFF_ROLES), specialtyDepartmentGuard('oncology'), sanitizeAllBodyStrings, phiAccessLogger('ONCOLOGY'), oncologyRoutes);

// NL-13 P4 — nuclear-medicine & radiotherapy COORDINATION (integrate-only). Referrals,
// external plan/fraction references, nuclear-medicine orders + radioisotope administration,
// and owner-sourced radiation-safety evidence. Ships inert behind a per-tenant flag; stores
// external references only (never computes plans / drives delivery). Same care-team-governed
// patient guard as the sibling specialty modules.
app.use('/api/v1/radiation-oncology', requireRole(...CLINICAL_STAFF_ROLES), specialtyDepartmentGuard('radiation_oncology'), sanitizeAllBodyStrings, patientAccessGuard('CLINICAL_WORKFLOW', { careTeamModeGoverned: true }), phiAccessLogger('RADIATION_ONCOLOGY'), radiationOncologyRoutes);
// Transplant program management (NL-13 P6) stays inert behind a per-tenant
// owner-evidence flag; service writes enforce transplant clinical privileges.
app.use('/api/v1/transplant', requireRole(...CLINICAL_STAFF_ROLES), specialtyDepartmentGuard('transplant'), sanitizeAllBodyStrings, patientAccessGuard('CLINICAL_WORKFLOW', { careTeamModeGoverned: true }), phiAccessLogger('TRANSPLANT_PROGRAM'), transplantRoutes);

// Dental charting (roadmap D7) — FDI tooth findings + procedure loop.
app.use('/api/v1/dental', requireRole(...CLINICAL_STAFF_ROLES), specialtyDepartmentGuard('dental'), sanitizeAllBodyStrings, patientAccessGuard('CLINICAL_WORKFLOW', { careTeamModeGoverned: true }), phiAccessLogger('DENTAL'), dentalRoutes);

// Ophthalmology (roadmap D7) — per-eye exams, IOP alerts, refractions.
app.use('/api/v1/ophthalmology', requireRole(...CLINICAL_STAFF_ROLES), specialtyDepartmentGuard('ophthalmology'), sanitizeAllBodyStrings, patientAccessGuard('CLINICAL_WORKFLOW', { careTeamModeGoverned: true }), phiAccessLogger('OPHTHALMOLOGY'), ophthalmologyRoutes);

// Physiotherapy and rehabilitation (NL6-11) — follow-up intake, rehab plans,
// structured sessions, and patient-visible outcome progress.
app.use('/api/v1/physio', requireRole(...PHYSIO_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('CLINICAL_WORKFLOW', { careTeamModeGoverned: true }), phiAccessLogger('PHYSIOTHERAPY'), physioRoutes);

// EMR — one role gate, then route-family PHI logging only for matching paths.
// Gap-audit 2026-08 (PHI mounts): the timeline mount MUST stay ahead of the
// broad /api/v1/emr gate (reception roles depend on that order — pinned by
// patientNamespaceRoutes.test.js), which means the later
// phiAccessLoggerForPaths('CLINICAL_NOTE', ...) mount that lists
// /api/v1/emr/timeline never fires for timeline reads: the earlier router
// terminates the request first. Carry the PHI access logger on THIS mount so
// the full unified patient timeline — the densest clinical read surface —
// lands in hipaa_access_log.
app.use('/api/v1/emr/timeline', requireRole(...EMR_TIMELINE_READ_ROLES), phiAccessLogger('EMR_TIMELINE'), clinicalTimelineRoutes);
app.use('/api/v1/emr', (req, res, next) => {
  const roles = isOrderSetStudioRequest(req) ? ORDER_SET_STUDIO_PARENT_ROLES : CLINICAL_STAFF_ROLES;
  return requireRole(...roles)(req, res, next);
});
const EMR_CLINICAL_NOTE_PATHS = [
  '/api/v1/emr/notes',
  '/api/v1/emr/timeline',
  '/api/v1/emr/downtime-snapshot',
];
const EMR_ADMISSION_PATHS = [
  '/api/v1/emr/command-board',
  '/api/v1/emr/admit',
  '/api/v1/emr/admission',
  '/api/v1/emr/admissions',
  /^\/api\/v1\/emr\/\d+\//,
];
const EMR_CLINICAL_ORDER_PATHS = [
  '/api/v1/emr/orders',
  '/api/v1/emr/order-sets',
];
const EMR_VITAL_SIGN_PATHS = [
  '/api/v1/emr/vitals',
  '/api/v1/emr/io',
];
const EMR_CLINICAL_DECISION_PATHS = [
  '/api/v1/emr/cds',
];
const EMR_DIAGNOSIS_PATHS = [
  '/api/v1/emr/diagnosis',
  '/api/v1/emr/icd10',
];
app.use('/api/v1/emr', patientAccessGuardForPaths('CLINICAL_NOTE', EMR_CLINICAL_NOTE_PATHS, { careTeamModeGoverned: true }),
  phiAccessLoggerForPaths('CLINICAL_NOTE', EMR_CLINICAL_NOTE_PATHS), clinicalNotesRoutes);
app.use('/api/v1/emr', patientAccessGuardForPaths('ADMISSION', EMR_ADMISSION_PATHS, { careTeamModeGoverned: true }),
  phiAccessLoggerForPaths('ADMISSION', EMR_ADMISSION_PATHS), admissionRoutes);
app.use('/api/v1/emr', patientAccessGuardForPaths('CLINICAL_ORDER', EMR_CLINICAL_ORDER_PATHS, { careTeamModeGoverned: true }),
  phiAccessLoggerForPaths('CLINICAL_ORDER', EMR_CLINICAL_ORDER_PATHS), orderRoutes);
app.use('/api/v1/emr', patientAccessGuardForPaths('VITAL_SIGN', EMR_VITAL_SIGN_PATHS, { careTeamModeGoverned: true }),
  phiAccessLoggerForPaths('VITAL_SIGN', EMR_VITAL_SIGN_PATHS), vitalsRoutes);
app.use('/api/v1/emr', patientAccessGuardForPaths('CLINICAL_DECISION', EMR_CLINICAL_DECISION_PATHS, { careTeamModeGoverned: true }),
  phiAccessLoggerForPaths('CLINICAL_DECISION', EMR_CLINICAL_DECISION_PATHS), cdsRoutes);
app.use('/api/v1/emr', patientAccessGuardForPaths('DIAGNOSIS', EMR_DIAGNOSIS_PATHS, { careTeamModeGoverned: true }),
  phiAccessLoggerForPaths('DIAGNOSIS', EMR_DIAGNOSIS_PATHS), diagnosisRoutes);

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
  requireSuperAdminStepUp, // CAN-043: SUPER_ADMIN must complete MFA step-up for the control plane
  adminIpAllowlist,
  adminRateLimiter,
  clinicalAiAdminRoutes
);
app.use(
  '/api/v1/clinical-ai/control',
  requireRole(...CLINICAL_AI_CONTROL_ROLES),
  requireSuperAdminStepUp, // CAN-043
  adminIpAllowlist,
  adminRateLimiter,
  clinicalAiAdminRoutes
);
app.use(
  '/api/v1/clinical-ai/clinical',
  requireRole(...CLINICAL_AI_USER_ROLES_LIST),
  phiAccessLogger('CLINICAL_AI'),
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
  requireSuperAdminStepUp, // CAN-043
  adminIpAllowlist,
  adminRateLimiter,
  adminForecastRoutes
);
app.use(
  '/api/v1/admin/tenants',
  requireRole('SUPER_ADMIN'),
  requireSuperAdminStepUp, // CAN-043
  adminIpAllowlist,
  adminRateLimiter,
  tenantRoutes
);
// W5 S1: the ADMIN-level read of the caller's OWN tenant identity + branding
// (NOT the SUPER_ADMIN-only tenant CRUD above). Any authenticated admin needs
// this to render its tenant chrome.
app.use(
  '/api/v1/admin/tenant-context',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  adminIpAllowlist,
  adminRateLimiter,
  tenantContextRoutes
);
// Legacy /api/v1/admin/ed paths — 308 redirect to the parallel clinical
// mount at /api/v1/ed (declared further above) so nurses using old URLs
// are transparently forwarded before the admin-role gate rejects them.
// Finding: 2026-05-08-emergency-walk-in-nurse-triage-rbac-blocks-nurses
app.use('/api/v1/admin/ed', (req, res) => {
  const target = req.originalUrl.replace('/api/v1/admin/ed', '/api/v1/ed');
  res.redirect(308, target);
});
// Legacy /api/v1/admin/surgical paths are deprecated — the parallel
// mount at /api/v1/surgical (declared further down) is the clinical-staff
// surface for preop / intraop / postop / safety-phase / anesthesia /
// implants / complications documentation. The legacy paths used to share
// the admin role gate, which surfaced as a misleading 403 when a nurse
// or OT staff (legitimately allowed on the new mount) hit the old URL.
// 308 preserves method + body so a POST stays a POST through the
// redirect — clients silently roll forward without losing the request.
// Mounted BEFORE the generic /api/v1/admin admin-role gate below so the
// redirect fires before any RBAC check rejects the request. Findings:
//   2026-05-15-surgical-day-care-nurse-43635edf (post-op)
//   2026-05-15-surgical-day-care-ot-staff-fabb6cdc (WHO time-out + preop)
app.use('/api/v1/admin/surgical', (req, res) => {
  const target = req.originalUrl.replace('/api/v1/admin/surgical', '/api/v1/surgical');
  res.redirect(308, target);
});
// SUPER_ADMIN step-up (audit 2026-06-18 — un-scoped bypass): requireRole grants
// SUPER_ADMIN an un-scoped bypass, so on these admin-portal control planes the
// master-key role must additionally present a 2FA-verified session
// (requireSuperAdminStepUp). Normal ADMINs are unaffected. Pairs with the
// REQUIRE_MFA_FOR_SUPER_ADMIN login flag — see docs/GO_LIVE_ACTIVATION_CHECKLIST.md.
app.use('/api/v1/admin', requireRole(...ADMIN_ROUTE_ROLES), requireSuperAdminStepUp, adminIpAllowlist, adminRateLimiter, adminDashboardRoutes);
app.use('/api/v1/admin/gamification', requireRole(...ADMIN_ROUTE_ROLES), requireSuperAdminStepUp, adminIpAllowlist, adminRateLimiter, adminGamificationRoutes);
// UHI evidence/dedupe ledger (migration 705) — read-only ops debugging surface.
app.use('/api/v1/admin/uhi', requireRole(...ADMIN_ROUTE_ROLES), requireSuperAdminStepUp, adminIpAllowlist, adminRateLimiter, uhiAdminRoutes);

// System settings + status — admin-portal surface, so IP-allowlisted like
// /api/v1/admin (fails closed in production until ADMIN_IP_ALLOWLIST is set;
// transparent in dev/test). Audit finding #5.
app.use('/api/v1/system', requireRole(...ADMIN_ROUTE_ROLES), requireSuperAdminStepUp, adminIpAllowlist, adminRateLimiter, systemRoutes);

// Audit + system logs — same admin-portal IP allowlist as /api/v1/admin.
// Previously role-gated + rate-limited but reachable from any IP in
// production; the audit/system log surface must match admin-dashboard
// network exposure. Audit finding #5.
app.use('/api/v1/logs', requireRole(...ADMIN_ROUTE_ROLES), requireSuperAdminStepUp, adminIpAllowlist, adminRateLimiter, logRoutes);

// Radiology
app.use('/api/v1/radiology', requireRole(...RADIOLOGY_ROUTE_ROLES), patientAccessGuard('RADIOLOGY', { careTeamModeGoverned: true }), phiAccessLogger('RADIOLOGY'), radiologyRoutes);

// Anatomic pathology / cytology
app.use('/api/v1/pathology', requireRole(...PATHOLOGY_ROUTE_ROLES), patientAccessGuard('PATHOLOGY', { careTeamModeGoverned: true }), phiAccessLogger('PATHOLOGY'), pathologyRoutes);

// Dietary / Nutrition — CAN-050: add the care-team-governed patient guard.
app.use('/api/v1/dietary', requireRole(...DIETARY_ROUTE_ROLES), patientAccessGuard('CLINICAL_WORKFLOW', { careTeamModeGoverned: true }), phiAccessLogger('DIETARY'), dietaryRoutes);

// Operating Theatre
app.use('/api/v1/theatre', requireRole(...THEATRE_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('OPERATING_THEATRE', { careTeamModeGoverned: true }), phiAccessLogger('OPERATING_THEATRE'), theatreRoutes);
// OR board shares the /theatre prefix but was mounted with role-only gating —
// missing the patient-access guard and PHI logging its sibling has, so broad
// theatre roles could read every patient's OR-board clinical state (and schedule
// surgery) un-audited (Sol Ultra #9/#12). Mirror the theatreRoutes middleware.
app.use('/api/v1/theatre', requireRole(...THEATRE_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('OPERATING_THEATRE', { careTeamModeGoverned: true }), phiAccessLogger('OPERATING_THEATRE'), orBoardRoutes);
app.use('/api/v1/anesthesia', requireRole(...THEATRE_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('ANESTHESIA_CHART', { careTeamModeGoverned: true }), phiAccessLogger('ANESTHESIA_CHART'), anesthesiaChartRoutes);
app.use('/api/v1/ctvs', requireRole(...THEATRE_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('CTVS_PERFUSION', { careTeamModeGoverned: true }), phiAccessLogger('CTVS_PERFUSION'), ctvsPerfusionRoutes);
app.use('/api/v1/cssd', requireRole(...CSSD_ROUTE_ROLES), sanitizeAllBodyStrings, cssdRoutes);

// Surgical documentation — mounted at /api/v1/surgical for clinical staff
// (OT nurses, surgeons, anaesthetists) who own these workflows in real
// life. The legacy /api/v1/admin/surgical path is deprecated — a 308
// redirect a few lines above forwards anyone still using the old URL.
// Findings:
//   2026-05-09-surgical-day-care-nurse-pacu-note-admin-only
//   2026-05-10-surgical-day-care-nurse-preop-checklist-admin-only
//   2026-05-10-surgical-day-care-ot-staff-timeout-recording-admin-only
//   2026-05-10-surgical-day-care-ot-staff-surgeon-op-notes-admin-only
//   2026-05-15-surgical-day-care-nurse-43635edf (legacy path → redirect)
//   2026-05-15-surgical-day-care-ot-staff-fabb6cdc (legacy path → redirect)
app.use(
  '/api/v1/surgical',
  requireRole(...THEATRE_ROUTE_ROLES),
  patientAccessGuard('SURGICAL_DOCUMENTATION', { careTeamModeGoverned: true }),
  phiAccessLogger('SURGICAL_DOCUMENTATION'),
  surgicalDocumentationRoutes,
);
app.use('/api/v1/microbiology', requireRole(...MICROBIOLOGY_ROUTE_ROLES), patientAccessGuard('MICROBIOLOGY', { careTeamModeGoverned: true }), phiAccessLogger('MICROBIOLOGY'), microbiologyRoutes);
// CAN-051: Form-F pregnancy/USG records are legally sensitive — add the
// care-team-governed patient guard (was role + PHI logger only).
app.use('/api/v1/pcpndt', requireRole(...PCPNDT_ROUTE_ROLES), patientAccessGuard('CLINICAL_WORKFLOW', { careTeamModeGoverned: true }), phiAccessLogger('PCPNDT'), pcpndtRoutes);
app.use('/api/v1/icu', requireRole(...ICU_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('ICU', { careTeamModeGoverned: true }), phiAccessLogger('ICU'), icuRoutes);
app.use('/api/v1/stroke-pathway', requireRole(...STROKE_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('STROKE_PATHWAY', { careTeamModeGoverned: true }), phiAccessLogger('STROKE_PATHWAY'), strokePathwayRoutes);
app.use('/api/v1/stemi-pathway', requireRole(...STEMI_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('STEMI_PATHWAY', { careTeamModeGoverned: true }), phiAccessLogger('STEMI_PATHWAY'), stemiPathwayRoutes);
app.use('/api/v1/clinical-alerts', requireRole(...CLINICAL_STAFF_ROLES), phiAccessLogger('CLINICAL_ALERTS'), clinicalAlertsRoutes);
// NL-14 P2: durable code-blue/resus documentation. Cross-patient emergency
// board (no patientAccessGuard — matches the clinical-alerts sibling);
// writes are fail-closed behind per-tenant resuscitation_settings.enabled.
app.use('/api/v1/resuscitation', requireRole(...CLINICAL_STAFF_ROLES), sanitizeAllBodyStrings, phiAccessLogger('RESUSCITATION'), resuscitationRoutes);
app.use('/api/v1/teleconsult', requireRole(...CLINICAL_STAFF_ROLES), phiAccessLogger('TELECONSULTATION'), teleconsultProvisioningRoutes);
app.use('/api/v1/compliance', requireRole(...COMPLIANCE_ROUTE_ROLES), phiAccessLogger('COMPLIANCE_BMW_DRUG_RETURNS'), bmwAndDrugReturnRoutes);
// Statutory public-health notifiable-disease register + Nikshay/IDSP/HMIS
// export files (G1) — dark-gated in the service layer (env
// PUBLIC_HEALTH_REGISTERS_ENABLED AND settings.publicHealthRegisters.enabled,
// fail-closed, default OFF).
app.use('/api/v1/public-health', requireRole(...COMPLIANCE_ROUTE_ROLES), phiAccessLogger('PUBLIC_HEALTH_NOTIFICATION'), publicHealthRoutes);
app.use('/api/v1/death-certification', requireRole(...FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES), patientAccessGuard('DEATH_CERTIFICATION', { careTeamModeGoverned: true }), phiAccessLogger('DEATH_CERTIFICATION'), deathCertificationRoutes);
// Birth notification / birth-certificate register (G4) — statutory symmetry
// with death-certification. Dark-gated in the service layer
// (requireBirthNotificationEnabled: env BIRTH_NOTIFICATION_ENABLED AND per-tenant
// settings.birthNotification.enabled, fail-closed, default OFF).
// No patientAccessGuard on THIS mount. It runs before Express has matched the
// route, so req.params is empty; every route here is keyed on a notification
// :id and none carries a patient identifier in the query, so the guard
// resolved no patient and returned no_patient_context without evaluating a
// policy — a control that could never decide. The router now guards each
// route with a selector that resolves birth_notifications.mother_patient_uid
// (see birthNotificationRoutes.js).
app.use('/api/v1/birth-notification', requireRole(...FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES), phiAccessLogger('BIRTH_NOTIFICATION'), birthNotificationRoutes);
app.use('/api/v1/dialysis', requireRole(...DIALYSIS_ROUTE_ROLES), patientAccessGuard('DIALYSIS', { careTeamModeGoverned: true }), phiAccessLogger('DIALYSIS'), dialysisRoutes);
app.use('/api/v1/cath-lab', requireRole(...CATH_LAB_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('CLINICAL_WORKFLOW', { careTeamModeGoverned: true }), phiAccessLogger('CATH_LAB'), cathLabRoutes);

// Blood Bank
app.use('/api/v1/blood-bank', requireRole(...BLOOD_BANK_ROUTE_ROLES), patientAccessGuard('BLOOD_BANK', { careTeamModeGoverned: true }), phiAccessLogger('BLOOD_BANK'), bloodBankRoutes);

// Online payment gateway (config-gated DEFAULT OFF; UPI + cards via a
// provider-abstracted adapter). Mounted BEFORE the generic /api/v1/billing
// mounts so their role gates cannot shadow this surface; PATIENT is admitted
// for self-payment order creation (service enforces ownership), admin config
// and refund execution are gated route-level.
app.use(
  '/api/v1/billing/gateway',
  requireRole(...BILLING_V2_ROUTE_ROLES, 'PATIENT'),
  billingPhiAccessLogger(),
  paymentGatewayRoutes,
);

// GST e-invoicing (IRN/IRP) + Tally/GL accounting export (G2) — dark-gated in
// the service layer (env GST_EINVOICE_ENABLED AND settings.gstEInvoice.enabled,
// fail-closed, default OFF). Mounted BEFORE the generic /api/v1/billing mounts
// so their role gates cannot shadow this surface.
app.use(
  '/api/v1/billing/gst',
  requireRole(...BILLING_V2_ROUTE_ROLES),
  billingPhiAccessLogger(),
  gstEInvoiceRoutes,
);

// Billing & Invoicing (mount-level role gate + route-level checks for mutations)
app.use(
  '/api/v1/billing/v2',
  requireRole(...BILLING_V2_ROUTE_ROLES),
  billingPhiAccessLogger(),
  billingV2Routes,
);
app.use('/api/v1/billing', requireRole(...BILLING_V2_ROUTE_ROLES, 'PATIENT'), billingPhiAccessLogger(), billingRoutes);
// Gap-audit 2026-08 (PHI mounts): revenue-cycle serves claim-grade PHI — the
// X12 837P claim document endpoint (GET .../837/:invoiceId) emits demographics
// + diagnoses as application/edi-x12 — but neither mount carried an access
// logger (billingPhiAccessLogger only matches /invoices|/payments paths).
app.use('/api/v1/billing', requireRole(...BILLING_ROUTE_ROLES), phiAccessLogger('REVENUE_CYCLE'), revenueCycleRoutes);
app.use('/api/v1/billing/revenue-cycle', requireRole(...BILLING_ROUTE_ROLES), phiAccessLogger('REVENUE_CYCLE'), revenueCycleTrackerRoutes);
// PATHOLOGIST + LAB_INCHARGE are the clinically-correct signoff tiers for
// /lab/pathologist/signoff (route-level requirePathologistTier enforces
// the inner gate). Including them at the mount-level requireRole keeps
// the seeded pathologist account from hitting a generic 403 before the
// tier-specific message ever reaches the client. Finding:
// 2026-05-10-emergency-walk-in-lab-tech-pathologist-signoff-rbac-blocked.
// E6 — staff-side result release controls (hold with reason / release
// early). Mounted BEFORE the generic /lab routers so their narrower
// LAB_ROUTE_ROLES gate cannot shadow the clinical-staff gate here.
app.use('/api/v1/lab/release', requireRole(...CLINICAL_STAFF_ROLES), patientAccessGuard('LAB_RESULT', { careTeamModeGoverned: true }), phiAccessLogger('LAB_RESULT'), resultReleaseRoutes);
app.use('/api/v1/diagnostic-results/release', requireRole(...CLINICAL_STAFF_ROLES, 'PATHOLOGIST'), phiAccessLogger('DIAGNOSTIC_RESULT'), structuredDiagnosticReleaseRoutes);
// Analyzer ingestion is mounted before the generic lab router because its
// narrow route gate admits configured machine service accounts. The router
// contains only the two ingest endpoints, so machine roles cannot reach lab
// result reads, sign-off, alerts, or specimen operations.
app.use('/api/v1/lab', requireRole(...LAB_INGEST_MOUNT_ROUTE_ROLES), labIngestRoutes);
app.use('/api/v1/lab', requireRole(...LAB_ROUTE_ROLES), patientAccessGuard('LAB_RESULT', { careTeamModeGoverned: true }), phiAccessLogger('LAB_RESULT'), labRoutes);
// A5 — structured panel entry + reference-range admin (sibling router under same /lab prefix).
app.use('/api/v1/lab', requireRole(...LAB_ROUTE_ROLES), patientAccessGuard('LAB_RESULT', { careTeamModeGoverned: true }), phiAccessLogger('LAB_RESULT'), labPanelRoutes);
app.use('/api/v1/lab', requireRole(...LAB_ROUTE_ROLES), patientAccessGuard('LAB_RESULT', { careTeamModeGoverned: true }), phiAccessLogger('LAB_RESULT'), labThresholdGovernanceRoutes);
// Gap-audit 2026-08 (PHI mounts): per-patient policies, preauth bundles, and
// claim documents are PHI reads — access-log them like sibling billing mounts.
app.use('/api/v1/insurance', requireRole(...BILLING_ROUTE_ROLES), phiAccessLogger('INSURANCE_CLAIM'), insuranceClaimsRoutes);
// Chart-shaped TPA enhancement surface — keyed off admission_id, open
// to clinicians so a treating consultant can initiate an enhancement
// from the patient chart instead of being routed through billing.
// See findings 2026-05-09-...-enhancement-in-billing-not-chart and
// 2026-05-10-...-doctor-enhancement-rbac.
app.use(
  '/api/v1/admissions/:admissionId/tpa-enhancement',
  requireRole(...BILLING_V2_ROUTE_ROLES),
  // Sol Ultra #8: this clinician-facing enhancement surface is keyed off the
  // :admissionId path param, so a plain patientAccessGuard would see no
  // patient_uid and pass. Resolve the admission -> patient and run the care-team
  // relationship decision (a foreign/unrelated admission 403s in enforce mode).
  patientAccessGuardForResource('INSURANCE_PREAUTH', {
    resourceType: 'admission',
    idParam: 'admissionId',
    careTeamModeGoverned: true,
    // When the admission id doesn't resolve to a patient (e.g. the chart surface
    // operates on preauth.admission_id without an admissions FK), defer to the
    // route's own ownership/existence check (404) instead of a hard 403 — the
    // care-team relationship is enforced whenever the admission DOES resolve.
    allowNoPatientResource: true,
  }),
  phiAccessLogger('INSURANCE_PREAUTH'),
  admissionEnhancementRoutes,
);
// Admission-desk alias for clients and swarm journeys that model ADT as
// `/api/v1/admissions/*` instead of the EMR-internal `/api/v1/emr/*`
// surface. Keep this after the more specific TPA-enhancement mount.
// The rewrite keeps one implementation in admissionRoutes while exposing
// REST-shaped reads/creates at:
//   POST/GET /api/v1/admissions, GET /api/v1/admissions/:id,
//   GET /api/v1/admissions/stats, GET /api/v1/admissions/patient/:uid
app.use(
  '/api/v1/admissions/occupancy',
  requireRole(...ADMISSION_OCCUPANCY_ROLES),
  phiAccessLogger('ADMISSION_OCCUPANCY'),
  admissionOccupancyRoutes,
);
app.use(
  '/api/v1/admissions',
  requireRole(...ADMISSION_SURFACE_ROLES),
  phiAccessLogger('ADMISSION'),
  admissionAliasRouter,
);
// Gap-audit 2026-08 (PHI mounts): PM-JAY beneficiaries/cases are looked up by
// patient uid — an unlogged government-scheme PHI surface until now.
app.use('/api/v1/pmjay', requireRole(...BILLING_ROUTE_ROLES), phiAccessLogger('PMJAY_CLAIM'), pmjayRoutes);
app.use('/api/v1/maternity', requireRole(...MATERNITY_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('MATERNITY_RECORD', { careTeamModeGoverned: true }), phiAccessLogger('MATERNITY_RECORD'), maternityRoutes);
// A10 — paediatric immunisation tracking. Receptionists need write access
// to seed a returning child's schedule; doctors + nurses to record doses.
app.use('/api/v1/paediatric', requireRole(...PAEDIATRIC_ROUTE_ROLES), patientAccessGuard('PAEDIATRIC_IMMUNISATION', { careTeamModeGoverned: true }), phiAccessLogger('PAEDIATRIC_IMMUNISATION'), paediatricImmunisationRoutes);
app.use('/api/v1/productivity', requireRole(...FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES), productivityRoutes);
// Admin BI dashboards (aggregate, non-PHI). Carries the same network-tier
// gate as its admin siblings (adminIpAllowlist + adminRateLimiter) — it was
// the one ADMIN_ROUTE_ROLES surface without them (2026-08-14 findings,
// backend-HTTP P3 #7). No SUPER_ADMIN step-up: aggregate BI reads are not a
// control-plane mutation surface (matches /admin/tenant-context posture).
app.use('/api/v1/dashboards', requireRole(...ADMIN_ROUTE_ROLES), adminIpAllowlist, adminRateLimiter, dashboardsRoutes);
// ABHA self-enrolment (migration 701) — mounted BEFORE the portal barrel so
// /portal/abdm/enrolment/* resolves here. Routes log their own
// logPhiAccess('abha_enrolment'); identity comes from the JWT only.
app.use('/api/v1/portal/abdm/enrolment', patientRateLimiter, requireRole('PATIENT'), abdmEnrolmentPortalRouter);
app.use('/api/v1/portal', patientRateLimiter, requireRole('PATIENT'), phiAccessLogger('PATIENT_PORTAL'), patientPortalRoutes);
app.use('/api/v1/patient', patientRateLimiter, requireRole('PATIENT'), phiAccessLogger('PATIENT_PORTAL'), patientPortalRoutes);
app.use('/api/v1/staff-messaging', requireRole(...STAFF_PATIENT_MESSAGING_ROUTE_ROLES), phiAccessLogger('PATIENT_MESSAGING'), staffMessagingRoutes);
app.use('/api/v1/discharge-summaries', requireRole(...FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('DISCHARGE_SUMMARY', { careTeamModeGoverned: true }), phiAccessLogger('DISCHARGE_SUMMARY'), dischargeRoutes);

// Quality & Infection Control (route-level role checks)
// CAN-035: incident + infection-control endpoints carry patient_uid/organism/
// treatment PHI but emitted no patient-attributed audit trail. Mount the PHI
// access logger so quality PHI access is breach-detectable like adjacent
// clinical routes.
app.use('/api/v1/quality', phiAccessLogger('QUALITY'), qualityRoutes);

// Referral Management (route-level role checks)
app.use('/api/v1/referrals', patientAccessGuard('REFERRAL', { careTeamModeGoverned: true }), phiAccessLogger('REFERRAL'), referralRoutes);

// Inter-staff messaging — open to every staff role. Stage-5 added the
// billing / TPA / admission-counter desk roles; the role-workflow sweep
// caught all four 403ing here because this hand-maintained allowlist was
// never updated for them.
// Gap-audit 2026-08 (PHI mounts): patient-linked staff discussions are
// access-GUARDED (CAN-013/014 patientAccessGuard inside the router) but were
// never access-LOGGED. Path-scoped to mirror the guard's exact route set
// (send / broadcast / thread attachments / the patient thread read) so
// patient-free ops chatter does not pollute the breach-detection trail.
const MESSAGING_PHI_PATHS = [
  '/api/v1/messaging/send',
  '/api/v1/messaging/broadcast',
  /^\/api\/v1\/messaging\/threads\/[^/]+\/attachments(?:\/|$)/,
  /^\/api\/v1\/messaging\/patient\//,
];
app.use('/api/v1/messaging', requireRole(...ALL_STAFF_MESSAGING_ROUTE_ROLES), phiAccessLoggerForPaths('STAFF_MESSAGING', MESSAGING_PHI_PATHS), messagingRoutes);

// Compliance: Breach Notification + Audit Search. Owner decision 2026-07-13:
// HR + admins read their OWN tenant's privacy incidents (SUPER_ADMIN gets
// cross-tenant); breachRoutes internally re-guards every non-read route with
// ADMIN_ROUTE_ROLES, so the wider mount only exposes the three read routes.
app.use('/api/v1/compliance', requireRole(...PEOPLE_OPERATIONS_ROUTE_ROLES), adminRateLimiter, breachRoutes);
app.use('/api/v1/compliance', requireRole(...ADMIN_ROUTE_ROLES), adminRateLimiter, auditSearchRoutes);
app.use('/api/v1/compliance', requireRole(...ADMIN_ROUTE_ROLES), adminRateLimiter, complianceIndicatorsRoutes);

// Serve report exports — protected behind JWT + admin role to prevent unauthorized access
app.use('/exports', requireRole(...ADMIN_ROUTE_ROLES), express.static('exports'));

// ====================================
// ERROR HANDLING
// ====================================

// Fallback rate limiter for unmatched paths (the terminal 404 below). Stays on
// the fail-open `default` profile by documented decision (873-F3): there is no
// resource behind an unmatched path, so denying it during a store outage buys
// nothing — see the `default` entry in rateLimitStoreLossPolicy.js.
app.use(genericLimiter);

// Terminal 404 (M19 — audit 2026-06-22). Any request that matched no route
// reaches here; without this it falls through to Express's default HTML
// "Cannot GET /x", breaking the JSON envelope every client expects. Returns the
// standard envelope. Must sit AFTER all route mounts and BEFORE the error
// handlers (a plain (req,res) middleware, not an error handler).
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'The requested resource was not found.',
    code: 'NOT_FOUND',
    ...(req.id ? { requestId: req.id } : {}),
  });
});

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

// Deliberately independent of CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED:
// code-to-route binding corruption must stop boot while capture remains inert.
assertClinicalContinuityActionBindings();

export default app;
