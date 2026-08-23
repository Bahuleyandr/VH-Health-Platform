// src/routes/admin/index.js
//
// Thin admin router: the dashboard/stats/SOS/upload handlers live in
// ./dashboardController.js (extracted in M20 — this file was a 697-line
// god-router with 36 inline closures and ~70 raw res.json calls). This file now
// only wires paths → handlers and mounts the admin sub-routers.
import express from 'express';
import { markRouterDomain } from '../../config/openapiDomain.js';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';

// Sub-routers (must remain mounted)
import analyticsRoutes from '../analyticsRoutes.js';
import adoptionRoutes from './adoptionRoutes.js';
import appointmentAdminRoutes from '../appointment/appointmentAdminRoutes.js';
import adminDepartmentRoutes from '../department/adminDepartmentRoutes.js';
import adminDoctorRoutes from '../doctor/adminDoctorRoutes.js';
import adminInvestigationRoutes from '../investigation/adminRoutes.js';
import adminNotificationRoutes from '../notification/adminNotificationRoutes.js';
import adminPharmacyRoutes from '../pharmacy/adminRoutes.js';
import adminRecordRoutes from '../record/adminRoutes.js';
import adminUserRoutes from '../user/adminUserRoutes.js';
import auditRoutes from './auditRoutes.js';
import eventOutboxRoutes from './eventOutboxRoutes.js';
import notificationOutboxRoutes from './notificationOutboxRoutes.js';
import smsConfigRoutes from './smsConfigRoutes.js';
import externalRecoveryOperabilityRoutes from './externalRecoveryOperabilityRoutes.js';
import carePathwayReconciliationRoutes from './carePathwayReconciliationRoutes.js';
import executiveKpiRoutes from './executiveKpiRoutes.js';
import entitlementRoutes from './entitlementRoutes.js';
import integrationGateRoutes from './integrationGateRoutes.js';
import featureFlagRoutes from './featureFlagRoutes.js';
import identitySsoRoutes from './identitySsoRoutes.js';
import interfaceEngineRoutes from './interfaceEngineRoutes.js';
import { deliveryRouter, integrationRouter, subscriptionRouter } from './integrationRoutes.js';
import patientIdentifierRoutes from './patientIdentifierRoutes.js';
import patientMergeRoutes from './patientMergeRoutes.js';
import surgicalDocumentationRoutes from './surgicalDocumentationRoutes.js';
import abdmFullRoutes from './abdmFullRoutes.js';
import billingMastersRoutes from './billingMastersRoutes.js';
import cathConsumablesRoutes from './cathConsumablesRoutes.js';
import { carePlansRouter, followUpsRouter } from './carePlanRoutes.js';
import clinicalGovernanceRoutes from './clinicalGovernanceRoutes.js';
import databaseRoutes from './databaseRoutes.js';
import deviceRegistryRoutes from './deviceRegistryRoutes.js';
import developerPortalRoutes from './developerPortalRoutes.js';
import ledgerReportsRoutes from './ledgerReportsRoutes.js';
import migrationToolkitRoutes from './migrationToolkitRoutes.js';
import edRoutes from './edRoutes.js';
import encryptionKeyRoutes from './encryptionKeyRoutes.js';
import facilityRoutes from './facilityRoutes.js';
import { apiClientsRouter } from './mfaApiClientsRoutes.js';
import pharmacySupplyRoutes from './pharmacySupplyRoutes.js';
import queueDisplayRoutes from './queueDisplayRoutes.js';
import smartFhirRoutes from './smartFhirRoutes.js';
import tasksWorkflowRoutes from './tasksWorkflowRoutes.js';
import telemedicineRoutes from './telemedicineRoutes.js';
import nhcxRoutes from './nhcxRoutes.js';
import { requireEntitlement } from '../../middleware/entitlementMiddleware.js';
import { ENTITLEMENT_FEATURE_KEYS } from '../../services/entitlements/entitlementService.js';

// Dashboard / stats / SOS / upload handlers (M20 extraction)
import * as dash from './dashboardController.js';

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                               RBAC-wrapped API                              */
/* -------------------------------------------------------------------------- */

// These handlers are all admin-console surfaces extracted to dashboardController,
// but they span SEVERAL real domains — and this barrel gives the OpenAPI generator
// no module signal (`admin/index.js` names nothing, and `admin` is an audience,
// never a domain). Left undeclared, their tags fall back to URL derivation and
// publish junk slugs that are shapes rather than subsystems: `test`, `alerts`,
// `activity`, `summary`, `export`, `refresh-cache`, plus a stray plural
// `appointments` alongside the real `appointment` tag.
//
// So each domain gets its own router carrying an explicit markRouterDomain
// declaration. Everything else is deliberately unchanged: the paths, the RBAC
// roles and the rate-limit/audit behaviour (every group passes the SAME
// `adminDashboard` configKey, and routeWrapper keys both off configKey — never
// off the router or the path), and the registration ORDER relative to the
// sub-router mounts below. Mounting each at '/' keeps every URL byte-identical;
// only the published tag moves.
//
// ★ These mounts MUST stay above the sub-router mounts below: '/appointments/summary'
// has to be matched here before router.use('/appointments', appointmentAdminRoutes).

// The console home itself: the aggregate dashboard, its activity feed and system
// alerts widgets, and the two dashboard-wide actions (cache refresh, report export).
const consoleRoutes = markRouterDomain(express.Router(), 'dashboard');
wrapAutoRBAC(consoleRoutes, 'adminDashboard', {
  get: [
    ['/dashboard', dash.dashboard],
    ['/activity/recent', dash.recentActivity],
    ['/alerts', dash.systemAlerts],
  ],

  post: [
    ['/refresh-cache', dash.refreshCache],
    ['/export/report', dash.exportReport],
  ],
});

const consoleStatsRoutes = markRouterDomain(express.Router(), 'stats');
wrapAutoRBAC(consoleStatsRoutes, 'adminDashboard', {
  get: [
    ['/stats/quick', dash.statsQuick],
    // Individual stat endpoints (used by portal useAdminStats)
    ['/stats/users', dash.statsUsers],
    ['/stats/doctors', dash.statsDoctors],
    ['/stats/appointments', dash.statsAppointments],
    ['/stats/records', dash.statsRecords],
    ['/stats/emergency', dash.statsEmergency],
    ['/stats/staff', dash.statsStaff],
    ['/stats/departments', dash.statsDepartments],
    // Same getStaffStats aggregate as /stats/staff, wrapped with a links block.
    ['/staff/summary', dash.staffSummary],
  ],
});

const consoleHealthRoutes = markRouterDomain(express.Router(), 'health');
wrapAutoRBAC(consoleHealthRoutes, 'adminDashboard', {
  get: [
    ['/health/modules', dash.moduleHealth],
    ['/health/system', dash.systemHealth],
  ],
});

// getAppointmentSummary + links into the appointment admin surface — the same
// domain as the /appointments sub-router mounted below, not a plural of its own.
const consoleAppointmentRoutes = markRouterDomain(express.Router(), 'appointment');
wrapAutoRBAC(consoleAppointmentRoutes, 'adminDashboard', {
  get: [['/appointments/summary', dash.appointmentsSummary]],
});

// Admin Staff Attendance
const consoleAttendanceRoutes = markRouterDomain(express.Router(), 'attendance');
wrapAutoRBAC(consoleAttendanceRoutes, 'adminDashboard', {
  get: [
    ['/staff/attendance/analytics', dash.attendanceAnalytics],
    ['/staff/attendance/anomalies', dash.attendanceAnomalies],
    ['/staff/attendance/late-arrivals', dash.lateArrivals],
    ['/staff/attendance/early-departures', dash.earlyDepartures],
    ['/staff/attendance/absent-report', dash.absentReport],
  ],
});

// Admin SOS management
const consoleSosRoutes = markRouterDomain(express.Router(), 'sos');
wrapAutoRBAC(consoleSosRoutes, 'adminDashboard', {
  get: [
    ['/sos/analytics', dash.sosAnalytics],
    ['/sos/alerts', dash.sosAlerts],
    ['/sos/emergency-services', dash.sosEmergencyServices],
    ['/sos/performance-report', dash.sosPerformanceReport],
  ],

  // No /sos/update-config — see the note on sosBroadcast in dashboardController.
  post: [
    ['/sos/broadcast', dash.sosBroadcast],
    ['/sos/escalate/:alertId', dash.sosEscalate],
  ],
});

// Admin Uploads (file management)
const consoleUploadRoutes = markRouterDomain(express.Router(), 'upload');
wrapAutoRBAC(consoleUploadRoutes, 'adminDashboard', {
  get: [
    ['/upload/summary', dash.uploadSummary],
    ['/upload/quarantine', dash.uploadQuarantine],
    ['/upload/hipaa/audit', dash.uploadHipaaAudit],
  ],

  post: [
    ['/upload/rescan/:fileId', dash.uploadRescan],
    ['/upload/cleanup', dash.uploadCleanup],
    ['/upload/hipaa/bulk-protect', dash.uploadHipaaBulkProtect],
    ['/upload/quarantine/purge', dash.uploadQuarantinePurge],
  ],
});

// /test is a self-description page (an index of the admin module URLs), i.e. the
// same API-discovery surface as /api-docs/discover — hence `infrastructure`, not
// a published `test` tag. Disabled in production to reduce attack surface.
const consoleDiagnosticsRoutes = markRouterDomain(express.Router(), 'infrastructure');
if ((process.env.NODE_ENV || '').toLowerCase() !== 'production') {
  wrapAutoRBAC(consoleDiagnosticsRoutes, 'adminDashboard', {
    get: [['/test', dash.testInfo]],
  });
}

// Package-level gate for the WHOLE admin surface. The catalog (migration 433)
// declares admin.operations enforcement_mode='hard_block' over /api/v1/admin,
// but until the 2026-08-23 once-over only three fine-grained mounts were
// gated — the catalog promised enforcement that did not exist. Order matters:
//   * /entitlements mounts ABOVE this gate so it stays reachable as the
//     recovery surface — a SUPER_ADMIN must always be able to inspect and
//     restore a tenant's package even when that tenant is hard-blocked
//     (same reachable-recovery pattern as the #906 infra /rbac mount).
//   * Existing tenants were seeded an active 'enterprise' entitlement by
//     migration 434, and tenantService.createTenant seeds new tenants, so
//     this gate changes nothing for provisioned tenants — it blocks only a
//     tenant whose package genuinely lacks admin.operations.
router.use('/entitlements', entitlementRoutes);
router.use(requireEntitlement(ENTITLEMENT_FEATURE_KEYS.adminOperations));

router.use(consoleDiagnosticsRoutes);
router.use(consoleRoutes);
router.use(consoleStatsRoutes);
router.use(consoleHealthRoutes);
router.use(consoleAppointmentRoutes);
router.use(consoleAttendanceRoutes);
router.use(consoleSosRoutes);
router.use(consoleUploadRoutes);

/* -------------------------------------------------------------------------- */
/*                           Mount admin sub-routers                           */
/* -------------------------------------------------------------------------- */

router.use('/audit', auditRoutes);
router.use('/adoption', adoptionRoutes);
router.use('/database', databaseRoutes);
router.use('/devices', deviceRegistryRoutes);
router.use('/developer-portal', developerPortalRoutes);
router.use('/ledger', ledgerReportsRoutes);
router.use('/migration-toolkit', migrationToolkitRoutes);
router.use('/events', eventOutboxRoutes);
router.use('/notification-outbox', notificationOutboxRoutes);
router.use('/continuity/external-recovery', externalRecoveryOperabilityRoutes);
router.use('/care-pathways/reconciliation', carePathwayReconciliationRoutes);
router.use('/appointments', appointmentAdminRoutes);
router.use('/doctors', adminDoctorRoutes);
router.use('/departments', adminDepartmentRoutes);
router.use('/users', adminUserRoutes);
// SMS gateway config (699/700) — mounted BEFORE the legacy '/notifications'
// router so its /notifications/sms/* paths are not shadowed.
router.use('/notifications/sms', smsConfigRoutes);
router.use('/notifications', adminNotificationRoutes);
router.use('/records', adminRecordRoutes);
router.use('/investigations', adminInvestigationRoutes);
router.use('/pharmacy', adminPharmacyRoutes);
router.use('/analytics', analyticsRoutes);
// /entitlements is mounted at the top of this file, ABOVE the barrel-wide
// admin.operations entitlement gate — see the comment there.
// SUPER_ADMIN-only dark-gate console read (route-level requireRole inside).
router.use('/integration-gates', integrationGateRoutes);
router.use('/feature-flags', requireEntitlement(ENTITLEMENT_FEATURE_KEYS.adminFeatureFlags), featureFlagRoutes);
router.use('/executive-kpi', executiveKpiRoutes);
router.use('/patient-identifiers', patientIdentifierRoutes);
router.use('/patient-merges', patientMergeRoutes);
router.use('/integrations', integrationRouter);
router.use('/interface-engine', interfaceEngineRoutes);
router.use('/webhook-subscriptions', subscriptionRouter);
router.use('/webhook-deliveries', deliveryRouter);
router.use('/identity', identitySsoRoutes);
router.use('/surgical', surgicalDocumentationRoutes);
router.use('/telemedicine', telemedicineRoutes);
router.use('/workflow', tasksWorkflowRoutes);
router.use('/billing-masters', requireEntitlement(ENTITLEMENT_FEATURE_KEYS.commercialBillingPackages), billingMastersRoutes);
router.use('/cath-consumables', cathConsumablesRoutes);
// /mfa was a second, parallel TOTP stack with no client caller and was removed
// (re-audit 2026-08-23). The live admin MFA path is /api/v1/auth/admin/mfa/*.
router.use('/api-clients', requireEntitlement(ENTITLEMENT_FEATURE_KEYS.developerApiClients), apiClientsRouter);
router.use('/facilities', facilityRoutes);
router.use('/care-plans', carePlansRouter);
router.use('/follow-ups', followUpsRouter);
router.use('/clinical-governance', clinicalGovernanceRoutes);
router.use('/pharmacy-supply', pharmacySupplyRoutes);
router.use('/queue-displays', queueDisplayRoutes);
router.use('/abdm', abdmFullRoutes);
router.use('/smart-fhir', smartFhirRoutes);
router.use('/encryption-keys', encryptionKeyRoutes);
router.use('/ed', edRoutes);
router.use('/nhcx', nhcxRoutes);

export default router;
