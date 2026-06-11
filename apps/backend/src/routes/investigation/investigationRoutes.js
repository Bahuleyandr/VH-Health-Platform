import express from 'express';
import multer from 'multer';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as bookingController from '../../controllers/investigation/bookingController.js';
import * as bulkController from '../../controllers/investigation/bulkController.js';
import * as investigationController from '../../controllers/investigation/investigationController.js';
import * as orderController from '../../controllers/investigation/orderController.js';
import * as uploadController from '../../controllers/investigation/uploadController.js';
import { sanitizeInvestigationFields } from '../../middleware/sanitizeMiddleware.js';
import { rejectMobileClinicalWrite } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import { validateFileContent, validateGenericDocumentUpload, validatePatientUpload } from '../../middleware/uploadMiddleware.js';
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

    // Booking routes (static before parameterized)
    ['/bookings/my', bookingController.getMyBookings],
    ['/bookings/queue', bookingController.getBookingQueue],
    ['/bookings/sla', bookingController.getBookingSLADashboard],
    ['/bookings/:id', bookingController.getBookingDetail],

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
    // Booking routes (static before parameterized)
    ['/bookings/create', rejectMobileClinicalWrite, upload.single('slip_photo'), validateFileContent, validatePatientUpload, sanitizeInvestigationFields, bookingController.createBooking],
    ['/bookings/:id/confirm', rejectMobileClinicalWrite, bookingController.confirmBooking],
    ['/bookings/:id/dispatch', rejectMobileClinicalWrite, bookingController.dispatchCollector],
    ['/bookings/:id/collected', rejectMobileClinicalWrite, bookingController.markCollected],
    ['/bookings/:id/processing', rejectMobileClinicalWrite, bookingController.startProcessing],
    ['/bookings/:id/result', rejectMobileClinicalWrite, upload.single('file'), validateFileContent, validateGenericDocumentUpload, bookingController.uploadResult],

    ['/catalog', investigationController.upsertTestCatalog],
    ['/order', rejectMobileClinicalWrite, investigationRequestValidator, orderController.orderInvestigation],
    ['/bulk/status', rejectMobileClinicalWrite, bulkController.updateStatus],
    // Wave-5 batch-3 — stamp sample collection on the investigations
    // row itself (not the booking). Surfaces a printable barcode +
    // collector/notes for the lab walk-in flow that bypasses bookings.
    ['/:id/collected', rejectMobileClinicalWrite, idValidator, investigationController.markInvestigationCollected],
    ['/:id/upload', rejectMobileClinicalWrite, upload.single('file'), validateFileContent, validateGenericDocumentUpload, uploadController.uploadResult],
    ['/', rejectMobileClinicalWrite, investigationRequestValidator, orderController.legacyInvestigationRequest]
  ],

delete: [
    ['/:id/files/:fileId', rejectMobileClinicalWrite, uploadController.removeFile]
  ],

  put: [
    ['/:id/status', rejectMobileClinicalWrite, updateStatusValidator, investigationController.updateInvestigationStatus],
    ['/:id/results', rejectMobileClinicalWrite, addResultsValidator, investigationController.addInvestigationResults]
  ]
});

export default router;
