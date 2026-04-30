import express from 'express';
import overviewRoutes from './clinicalAi/overviewRoutes.js';
import governanceRoutes from './clinicalAi/governanceRoutes.js';
import documentRoutes from './clinicalAi/documentRoutes.js';
import coreClinicalRoutes from './clinicalAi/coreClinicalRoutes.js';
import careOperationsRoutes from './clinicalAi/careOperationsRoutes.js';
import revenueCycleRoutes from './clinicalAi/revenueCycleRoutes.js';
import diagnosticsMedicationRoutes from './clinicalAi/diagnosticsMedicationRoutes.js';
import facilityRiskRoutes from './clinicalAi/facilityRiskRoutes.js';
import platformWorkbenchRoutes from './clinicalAi/platformWorkbenchRoutes.js';
import knowledgeBaseRoutes from './clinicalAi/knowledgeBaseRoutes.js';
import knowledgeGovernanceRoutes from './clinicalAi/knowledgeGovernanceRoutes.js';
import trialSafetyOperationsRoutes from './clinicalAi/trialSafetyOperationsRoutes.js';
import dischargeComposeRoutes from './clinicalAi/dischargeComposeRoutes.js';
import { requireClinicalAiControl } from './clinicalAi/shared.js';

const router = express.Router();

router.use(requireClinicalAiControl);
router.use('/', overviewRoutes);
router.use('/', governanceRoutes);
router.use('/', documentRoutes);
router.use('/', coreClinicalRoutes);
router.use('/', careOperationsRoutes);
router.use('/', revenueCycleRoutes);
router.use('/', diagnosticsMedicationRoutes);
router.use('/', facilityRiskRoutes);
router.use('/', platformWorkbenchRoutes);
router.use('/', knowledgeBaseRoutes);
router.use('/', knowledgeGovernanceRoutes);
router.use('/', trialSafetyOperationsRoutes);
router.use('/', dischargeComposeRoutes);

export default router;
