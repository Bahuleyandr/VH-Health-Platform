import express from 'express';

import {
  PATIENT_FLOW_SETTINGS_ROUTE_ROLES,
  PATIENT_FLOW_SUPERVISED_ROUTE_ROLES,
  PATIENT_TRANSPORT_ROUTE_ROLES,
  PATIENT_TRANSPORT_SETTINGS_ROUTE_ROLES,
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
import {
  getMyTransportTasks,
  getTransportSettings,
  getTransportTaskById,
  getTransportTasks,
  getTransportZones,
  postTransportTask,
  postTransportTaskAccept,
  postTransportTaskAssign,
  postTransportTaskCancel,
  postTransportTaskComplete,
  postTransportTaskPickup,
  putTransportSettings,
  putTransportZone,
} from '../../controllers/patientFlow/porterTransportController.js';

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

router.get(
  '/transport/settings',
  requireRole(...PATIENT_TRANSPORT_ROUTE_ROLES),
  wrapAsync(getTransportSettings),
);

router.put(
  '/transport/settings',
  requireRole(...PATIENT_TRANSPORT_SETTINGS_ROUTE_ROLES),
  wrapAsync(putTransportSettings),
);

router.get(
  '/transport/zones',
  requireRole(...PATIENT_TRANSPORT_ROUTE_ROLES),
  wrapAsync(getTransportZones),
);

router.put(
  '/transport/zones/:zoneKey',
  requireRole(...PATIENT_TRANSPORT_SETTINGS_ROUTE_ROLES),
  wrapAsync(putTransportZone),
);

router.post(
  '/transport/tasks',
  requireRole(...PATIENT_TRANSPORT_ROUTE_ROLES),
  wrapAsync(postTransportTask),
);

router.get(
  '/transport/tasks',
  requireRole(...PATIENT_TRANSPORT_ROUTE_ROLES),
  wrapAsync(getTransportTasks),
);

router.get(
  '/transport/tasks/my',
  requireRole(...PATIENT_TRANSPORT_ROUTE_ROLES),
  wrapAsync(getMyTransportTasks),
);

router.get(
  '/transport/tasks/:taskId',
  requireRole(...PATIENT_TRANSPORT_ROUTE_ROLES),
  wrapAsync(getTransportTaskById),
);

router.post(
  '/transport/tasks/:taskId/assign',
  requireRole(...PATIENT_TRANSPORT_ROUTE_ROLES),
  wrapAsync(postTransportTaskAssign),
);

router.post(
  '/transport/tasks/:taskId/accept',
  requireRole(...PATIENT_TRANSPORT_ROUTE_ROLES),
  wrapAsync(postTransportTaskAccept),
);

router.post(
  '/transport/tasks/:taskId/pickup',
  requireRole(...PATIENT_TRANSPORT_ROUTE_ROLES),
  wrapAsync(postTransportTaskPickup),
);

router.post(
  '/transport/tasks/:taskId/complete',
  requireRole(...PATIENT_TRANSPORT_ROUTE_ROLES),
  wrapAsync(postTransportTaskComplete),
);

router.post(
  '/transport/tasks/:taskId/cancel',
  requireRole(...PATIENT_TRANSPORT_ROUTE_ROLES),
  wrapAsync(postTransportTaskCancel),
);

export default router;
