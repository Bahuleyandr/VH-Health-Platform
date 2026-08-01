import express from 'express';

import {
  appendIncidentAlias,
  approveIdentityMatch,
  attestClosure,
  backfillMedicationAdministration,
  backfillSpecimenCollection,
  backfillTransfusionVerification,
  checkClosure,
  closeIncident,
  decideReconciliationItem,
  declareIncident,
  executeIdentityMatch,
  importIncident,
  listWorkbench,
  proposeIdentityMatch,
  recordDeviceOffset,
  recordInterfaceRequirement,
  recordRangeDisposition,
  registerPaperItem,
  transitionIncident,
} from '../../controllers/downtime/clinicalContinuityReconciliationController.js';
import { requireClinicalContinuityReconciliationContext } from '../../middleware/clinicalContinuityReconciliationMiddleware.js';

const router = express.Router();

router.use(requireClinicalContinuityReconciliationContext);

router.get('/workbench', listWorkbench);
router.post('/incidents/declare', declareIncident);
router.post('/incidents/import', importIncident);
router.patch('/incidents/:incidentId/state', transitionIncident);
router.post('/incidents/:incidentId/range-disposition', recordRangeDisposition);
router.post('/incident-aliases', appendIncidentAlias);
router.post('/incidents/:incidentId/paper-items/:paperItemId', registerPaperItem);

// The command map is intentionally closed. There is no generic /replay or
// arbitrary-action route, and no admission/transfer/discharge endpoint.
router.post(
  '/incidents/:incidentId/paper-items/:paperItemId/mar-administration',
  backfillMedicationAdministration,
);
router.post(
  '/incidents/:incidentId/paper-items/:paperItemId/lab-specimen-collection',
  backfillSpecimenCollection,
);
router.post(
  '/incidents/:incidentId/paper-items/:paperItemId/blood-transfusion-verification',
  backfillTransfusionVerification,
);

router.post('/reconciliation-items/:itemId/decision', decideReconciliationItem);
router.put('/incidents/:incidentId/devices/:deviceId/offset', recordDeviceOffset);
router.put('/incidents/:incidentId/interfaces/requirement', recordInterfaceRequirement);

router.post('/incidents/:incidentId/identity-matches', proposeIdentityMatch);
router.post('/identity-matches/:mergeId/approve', approveIdentityMatch);
router.post('/identity-matches/:mergeId/execute', executeIdentityMatch);

router.get('/incidents/:incidentId/closure', checkClosure);
router.post('/incidents/:incidentId/closure/attestations', attestClosure);
router.post('/incidents/:incidentId/closure/close', closeIncident);

export default router;
