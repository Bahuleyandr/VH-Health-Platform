// src/routes/admin/executiveKpiRoutes.js
import express from 'express';
import { getExecutiveKpi } from '../../controllers/admin/executiveKpiController.js';

const router = express.Router();
router.get('/summary', getExecutiveKpi);
export default router;
