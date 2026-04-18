// src/routes/compliance/indicatorsRoutes.js
import express from 'express';
import { getComplianceIndicators } from '../../controllers/compliance/indicatorsController.js';

const router = express.Router();
router.get('/indicators', getComplianceIndicators);
export default router;
