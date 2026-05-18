// src/routes/pharmacy/wardIndentRoutes.js
//
// IPD ward → pharmacy stores indent workflow REST surface.
// Mounted at /api/v1/pharmacy/ward-indents from routes/pharmacy/index.js.
//
// Finding: 2026-05-08-inpatient-admission-pharmacy-no-ipd-ward-indent.

import express from 'express';
import * as ctl from '../../controllers/pharmacy/wardIndentController.js';

const router = express.Router();

router.get('/', ctl.listIndents);
router.get('/:id', ctl.getIndent);
router.post('/', ctl.createIndent);
router.post('/:id/approve', ctl.approveIndent);
router.post('/:id/reject', ctl.rejectIndent);
router.post('/:id/issue', ctl.issueIndent);
router.post('/:id/receive', ctl.receiveIndent);

export default router;
