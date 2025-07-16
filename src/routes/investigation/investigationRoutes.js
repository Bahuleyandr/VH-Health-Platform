import express from 'express';
import multer from 'multer';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as investigationController from '../../controllers/investigation/investigationController.js';
import * as orderController from '../../controllers/investigation/orderController.js';
import * as uploadController from '../../controllers/investigation/uploadController.js';
import { 
  investigationRequestValidator,
  idValidator,
  updateStatusValidator,
  addResultsValidator,
  listInvestigationsValidator,
  patientIdValidator,
  doctorIdValidator,
  typeValidator
} from '../../validators/investigation/investigationValidators.js';

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const router = express.Router();

// Patient & Medical Staff Routes
wrapAutoRBAC(router, 'investigationRoutes', {
  get: [
    ['/list', listInvestigationsValidator, investigationController.listInvestigations],
    ['/:id', idValidator, investigationController.getInvestigationById],
    ['/:id/files', uploadController.getFiles],
    ['/:id/files/:fileId', uploadController.getFileInfo],
    ['/:id/files/:fileId/download', uploadController.downloadFile],
    ['/patient/:patient_id', patientIdValidator, investigationController.getPatientInvestigations],
    ['/doctor/:doctor_id', doctorIdValidator, investigationController.getDoctorInvestigations],
    ['/type/:type', typeValidator, investigationController.getInvestigationsByType],
    ['/status/pending', investigationController.getPendingInvestigations],
    
    // Legacy routes
    ['/:phone', investigationController.getInvestigationsByPhone],
    ['/uid/:uid', investigationController.getInvestigationsByUID]
  ],
  
  post: [
    ['/order', investigationRequestValidator, orderController.orderInvestigation],
    ['/:id/upload', upload.single('file'), uploadController.uploadResult],    
    ['/', investigationRequestValidator, orderController.legacyInvestigationRequest]
  ],

delete: [
    ['/:id/files/:fileId', uploadController.removeFile]
  ],

  put: [
    ['/:id/status', updateStatusValidator, investigationController.updateInvestigationStatus],
    ['/:id/results', addResultsValidator, investigationController.addInvestigationResults]
  ]
});

export default router;