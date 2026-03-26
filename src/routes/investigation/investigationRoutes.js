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
    // Static routes MUST come before parameterized routes
    ['/catalog', investigationController.getTestCatalog],
    ['/sla-dashboard', investigationController.getInvestigationSLADashboard],
    ['/list', listInvestigationsValidator, investigationController.listInvestigations],
    ['/status/pending', investigationController.getPendingInvestigations],
    ['/patient/:patient_id', patientIdValidator, investigationController.getPatientInvestigations],
    ['/doctor/:doctor_id', doctorIdValidator, investigationController.getDoctorInvestigations],
    ['/type/:type', typeValidator, investigationController.getInvestigationsByType],
    ['/uid/:uid', investigationController.getInvestigationsByUID],
    ['/:id/files', uploadController.getFiles],
    ['/:id/files/:fileId', uploadController.getFileInfo],
    ['/:id/files/:fileId/download', uploadController.downloadFile],
    ['/:id', idValidator, investigationController.getInvestigationById],
    
    // Legacy routes (parameterized — must be last)
    ['/:phone', investigationController.getInvestigationsByPhone]
  ],
  
  post: [
    ['/catalog', investigationController.upsertTestCatalog],
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