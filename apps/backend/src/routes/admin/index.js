// src/routes/admin/index.js
//
// Thin admin router: the dashboard/stats/SOS/upload handlers live in
// ./dashboardController.js (extracted in M20 — this file was a 697-line
// god-router with 36 inline closures and ~70 raw res.json calls). This file now
// only wires paths → handlers and mounts the admin sub-routers.
import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';

// Sub-routers (must remain mounted)
import analyticsRoutes from '../analyticsRoutes.js';
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
import executiveKpiRoutes from './executiveKpiRoutes.js';
import featureFlagRoutes from './featureFlagRoutes.js';
import { deliveryRouter, integrationRouter, subscriptionRouter } from './integrationRoutes.js';
import patientIdentifierRoutes from './patientIdentifierRoutes.js';
import patientMergeRoutes from './patientMergeRoutes.js';
import surgicalDocumentationRoutes from './surgicalDocumentationRoutes.js';
import abdmFullRoutes from './abdmFullRoutes.js';
import billingMastersRoutes from './billingMastersRoutes.js';
import { carePlansRouter, followUpsRouter } from './carePlanRoutes.js';
import clinicalGovernanceRoutes from './clinicalGovernanceRoutes.js';
import databaseRoutes from './databaseRoutes.js';
import ledgerReportsRoutes from './ledgerReportsRoutes.js';
import edRoutes from './edRoutes.js';
import encryptionKeyRoutes from './encryptionKeyRoutes.js';
import facilityRoutes from './facilityRoutes.js';
import { apiClientsRouter, mfaRouter } from './mfaApiClientsRoutes.js';
import pharmacySupplyRoutes from './pharmacySupplyRoutes.js';
import smartFhirRoutes from './smartFhirRoutes.js';
import tasksWorkflowRoutes from './tasksWorkflowRoutes.js';
import telemedicineRoutes from './telemedicineRoutes.js';
import nhcxRoutes from './nhcxRoutes.js';

// Dashboard / stats / SOS / upload handlers (M20 extraction)
import * as dash from './dashboardController.js';

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                               RBAC-wrapped API                              */
/* -------------------------------------------------------------------------- */

wrapAutoRBAC(router, 'adminDashboard', {
  get: [
    // /test — disabled in production to reduce attack surface
    ...((process.env.NODE_ENV || '').toLowerCase() !== 'production'
      ? [['/test', dash.testInfo]]
      : []),

    ['/dashboard', dash.dashboard],

    ['/stats/quick', dash.statsQuick],
    // Individual stat endpoints (used by portal useAdminStats)
    ['/stats/users', dash.statsUsers],
    ['/stats/doctors', dash.statsDoctors],
    ['/stats/appointments', dash.statsAppointments],
    ['/stats/records', dash.statsRecords],
    ['/stats/emergency', dash.statsEmergency],
    ['/stats/staff', dash.statsStaff],
    ['/stats/departments', dash.statsDepartments],

    ['/activity/recent', dash.recentActivity],
    ['/alerts', dash.systemAlerts],
    ['/health/modules', dash.moduleHealth],
    ['/health/system', dash.systemHealth],
    ['/staff/summary', dash.staffSummary],
    ['/appointments/summary', dash.appointmentsSummary],

    // Admin Staff Attendance
    ['/staff/attendance/analytics', dash.attendanceAnalytics],
    ['/staff/attendance/anomalies', dash.attendanceAnomalies],
    ['/staff/attendance/late-arrivals', dash.lateArrivals],
    ['/staff/attendance/early-departures', dash.earlyDepartures],
    ['/staff/attendance/absent-report', dash.absentReport],

    // Admin SOS management
    ['/sos/analytics', dash.sosAnalytics],
    ['/sos/alerts', dash.sosAlerts],
    ['/sos/emergency-services', dash.sosEmergencyServices],
    ['/sos/performance-report', dash.sosPerformanceReport],

    // Admin Uploads (file management)
    ['/upload/summary', dash.uploadSummary],
    ['/upload/quarantine', dash.uploadQuarantine],
    ['/upload/hipaa/audit', dash.uploadHipaaAudit],
  ],

  post: [
    ['/refresh-cache', dash.refreshCache],
    ['/export/report', dash.exportReport],

    // SOS actions
    ['/sos/update-config', dash.sosUpdateConfig],
    ['/sos/broadcast', dash.sosBroadcast],
    ['/sos/escalate/:alertId', dash.sosEscalate],

    // Upload actions
    ['/upload/rescan/:fileId', dash.uploadRescan],
    ['/upload/cleanup', dash.uploadCleanup],
    ['/upload/hipaa/bulk-protect', dash.uploadHipaaBulkProtect],
    ['/upload/quarantine/purge', dash.uploadQuarantinePurge],
  ],
});

/* -------------------------------------------------------------------------- */
/*                           Mount admin sub-routers                           */
/* -------------------------------------------------------------------------- */

router.use('/audit', auditRoutes);
router.use('/database', databaseRoutes);
router.use('/ledger', ledgerReportsRoutes);
router.use('/events', eventOutboxRoutes);
router.use('/appointments', appointmentAdminRoutes);
router.use('/doctors', adminDoctorRoutes);
router.use('/departments', adminDepartmentRoutes);
router.use('/users', adminUserRoutes);
router.use('/notifications', adminNotificationRoutes);
router.use('/records', adminRecordRoutes);
router.use('/investigations', adminInvestigationRoutes);
router.use('/pharmacy', adminPharmacyRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/feature-flags', featureFlagRoutes);
router.use('/executive-kpi', executiveKpiRoutes);
router.use('/patient-identifiers', patientIdentifierRoutes);
router.use('/patient-merges', patientMergeRoutes);
router.use('/integrations', integrationRouter);
router.use('/webhook-subscriptions', subscriptionRouter);
router.use('/webhook-deliveries', deliveryRouter);
router.use('/surgical', surgicalDocumentationRoutes);
router.use('/telemedicine', telemedicineRoutes);
router.use('/workflow', tasksWorkflowRoutes);
router.use('/billing-masters', billingMastersRoutes);
router.use('/mfa', mfaRouter);
router.use('/api-clients', apiClientsRouter);
router.use('/facilities', facilityRoutes);
router.use('/care-plans', carePlansRouter);
router.use('/follow-ups', followUpsRouter);
router.use('/clinical-governance', clinicalGovernanceRoutes);
router.use('/pharmacy-supply', pharmacySupplyRoutes);
router.use('/abdm', abdmFullRoutes);
router.use('/smart-fhir', smartFhirRoutes);
router.use('/encryption-keys', encryptionKeyRoutes);
router.use('/ed', edRoutes);
router.use('/nhcx', nhcxRoutes);

export default router;
