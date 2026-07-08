import express from 'express';

import {
  PATIENT_FLOW_SETTINGS_ROUTE_ROLES,
  PATIENT_FLOW_SUPERVISED_ROUTE_ROLES,
} from '../../config/routeRolePolicy.js';
import { wrapAsync } from '../../config/routeWrapper.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import {
  getKioskSettings,
  postKioskSession,
  postPatientCheckin,
  postSupervisedCheckin,
  putKioskSetting,
} from '../../controllers/patientFlow/kioskCheckinController.js';

const router = express.Router();

router.get(
  '/kiosk/settings',
  requireRole(...PATIENT_FLOW_SUPERVISED_ROUTE_ROLES),
  wrapAsync(getKioskSettings),
);

router.put(
  '/kiosk/settings/:departmentKey',
  requireRole(...PATIENT_FLOW_SETTINGS_ROUTE_ROLES),
  wrapAsync(putKioskSetting),
);

router.post(
  '/kiosk/sessions',
  requireRole(...PATIENT_FLOW_SUPERVISED_ROUTE_ROLES),
  wrapAsync(postKioskSession),
);

router.post(
  '/checkins/patient',
  requireRole('PATIENT'),
  wrapAsync(postPatientCheckin),
);

router.post(
  '/checkins/supervised',
  requireRole(...PATIENT_FLOW_SUPERVISED_ROUTE_ROLES),
  wrapAsync(postSupervisedCheckin),
);

export default router;
