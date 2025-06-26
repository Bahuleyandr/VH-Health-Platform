import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as investigationController from '../../controllers/investigation/investigationController.js';
import * as orderController from '../../controllers/investigation/orderController.js';
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

const router = express.Router();

// Patient & Medical Staff Routes
wrapAutoRBAC(router, 'investigationRoutes', {
  get: [
    ['/list', listInvestigationsValidator, investigationController.listInvestigations],
    ['/:id', idValidator, investigationController.getInvestigationById],
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
    ['/', investigationRequestValidator, orderController.legacyInvestigationRequest]
  ],
  
  put: [
    ['/:id/status', updateStatusValidator, investigationController.updateInvestigationStatus],
    ['/:id/results', addResultsValidator, investigationController.addInvestigationResults]
  ]
});

export default router;