import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as medicalController from '../../controllers/staff/medicalController.js';
import { 
  consultationUploadValidation,
  investigationUploadValidation 
} from '../../validators/staff/medicalValidators.js';

const router = express.Router();

wrapAutoRBAC(router, 'staffMedicalRoutes', {
  post: [
    ['/consultations', consultationUploadValidation, medicalController.uploadConsultation],
    ['/investigations', investigationUploadValidation, medicalController.uploadInvestigation]
  ]
});

export default router;