import express from 'express';

import { markRouterDomain } from '../../config/openapiDomain.js';
import { ALL_STAFF_MESSAGING_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import {
  countersignAdvance,
  createAdvanceIntent,
  getState,
  haltActivation,
} from '../../controllers/downtime/clinicalContinuityActivationTransitionController.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';

const router = markRouterDomain(express.Router(), 'downtime');

// The broad authenticated-staff gate only admits the request to the command
// surface. The exact current identity must still be present in the empty-by-
// default C-D11 roster before any intent or halt can be recorded.
router.use(requireRole(...ALL_STAFF_MESSAGING_ROUTE_ROLES));

router.get('/facilities/:facilityId/state', getState);
router.post('/facilities/:facilityId/advance-intents', createAdvanceIntent);
router.post(
  '/facilities/:facilityId/advance-intents/:intentEventId/countersign',
  countersignAdvance,
);
router.post('/facilities/:facilityId/halt', haltActivation);

export default router;
