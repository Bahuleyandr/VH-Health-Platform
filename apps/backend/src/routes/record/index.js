// src/routes/record/index.js
import express from 'express';
import { VALID_RECORD_TYPES } from '../../config/recordConfig.js';
import { wrapRoutesWithValidation } from '../../config/routeWrapper.js';
import logger from '../../logging/logger.js';
import adminRoutes from './adminRoutes.js';
import doctorRoutes from './doctorRoutes.js';
import medicalStaffRoutes from './medicalStaffRoutes.js';
import patientRoutes from './patientRoutes.js';

const router = express.Router();
logger.info('✅ Enhanced recordRoutes loaded');

// Public test route
wrapRoutesWithValidation(
  router,
  [],
  {
    get: [
      [
        '/test',
        [],
        (req, res) => {
          res.json({ 
            message: 'Enhanced Medical Records routes working!',
            timestamp: new Date().toLocaleDateString('en-GB'),
            version: '3.0.0-enhanced',
            features: [
              'RBAC Protection', 'HIPAA Compliance', 'Privacy Levels', 
              'Audit Logging', 'Role-based Access', 'Medical Record Management'
            ],
            recordTypes: VALID_RECORD_TYPES
          });
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

// RBAC model for /records (these subrouters all mount at '/', so a per-subrouter
// wrapAutoRBAC({use:[['/',sub]]}) would make each mount's rbac run on EVERY
// fall-through request — an unintended role intersection. Instead:
//   * the parent mount (app.js) gates all of /records with RECORD_ROUTE_ROLES +
//     patientAccessGuard('MEDICAL_RECORD') + phiAccessLogger;
//   * sensitive WRITE/admin routes gate themselves inline with requireRole
//     (doctorRoutes create/update = [DOCTOR,ADMIN]; adminRoutes analytics/
//     hipaa-audit/delete = [ADMIN,SUPER_ADMIN] — HEAD-006);
//   * uid/phone patient reads carry per-route care-team guards (CAN-039).
// The prior wrapAutoRBAC(<subrouter>, 'key') calls here were inert no-ops (a
// subrouter passed as the 1st arg with no routeMap attaches nothing) and were
// removed to avoid implying RBAC that was never applied (see the no-op-RBAC
// guard test).
router.use('/', patientRoutes);
router.use('/', medicalStaffRoutes);
router.use('/', doctorRoutes);
router.use('/', adminRoutes);

export default router;