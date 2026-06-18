import express from 'express';
import { list, decide, sweep } from '../../../controllers/admin/clinicalAi/operationalAlertController.js';

const router = express.Router();
router.get('/operational-alerts', list);
router.post('/operational-alerts/:id/decision', decide);
router.post('/operational-alerts/run-sweep', sweep);
export default router;
