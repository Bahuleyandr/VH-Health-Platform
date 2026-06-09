import express from 'express';
import multer from 'multer';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as ePrescriptionController from '../../controllers/prescription/ePrescriptionController.js';
import * as pharmacyOrderController from '../../controllers/pharmacy/pharmacyOrderController.js';
import logger from '../../logging/logger.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { rejectMobileClinicalWrite } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import { prescriptionAttachmentFileFilter } from '../../utils/prescriptionAttachmentFilter.js';

const router = express.Router();

logger.info('✅ E-Prescription routes loaded');

// Multer for handwritten prescription photo
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: prescriptionAttachmentFileFilter
});

// Static paths BEFORE /:id

// Shared formulary type-ahead for clinical prescribing screens. This reuses
// the pharmacy catalog controller, but keeps OP/IP prescription screens away
// from the broader /pharmacy-orders route surface.
wrapAutoRBAC(router, 'pharmacyCatalogRoutes', {
  get: [['/catalog', [], pharmacyOrderController.getCatalog]]
});

// Staff/admin create prescription — idempotency-key middleware on
// /create so retries don't duplicate scripts. Header-driven, optional.
wrapAutoRBAC(router, 'ePrescriptionCreateRoutes', {
  post: [
    ['/create',
      [
        requireIdempotencyKey({ required: false, scope: 'prescription_create' }),
        rejectMobileClinicalWrite,
        upload.single('handwritten_photo'),
      ],
      ePrescriptionController.createPrescription],
    ['/safety-check', [], ePrescriptionController.previewSafetyCheck]
  ]
});

// Patient: my prescriptions
wrapAutoRBAC(router, 'ePrescriptionPatientRoutes', {
  get: [
    ['/patient/my', [], ePrescriptionController.getMyPrescriptions],
    ['/all', [], ePrescriptionController.getAllPrescriptions]
  ]
});

// By appointment
wrapAutoRBAC(router, 'ePrescriptionAppointmentRoutes', {
  get: [
    ['/appointment/:appointmentId', [], ePrescriptionController.getPrescriptionByAppointment]
  ]
});

// PDF download
wrapAutoRBAC(router, 'ePrescriptionPdfRoutes', {
  get: [
    ['/pdf/:id', [], ePrescriptionController.downloadPrescriptionPDF]
  ]
});

// Dynamic /:id routes last. Idempotency on the two write paths that
// create downstream pharmacy orders (order-pharmacy + refill).
wrapAutoRBAC(router, 'ePrescriptionDetailRoutes', {
  get: [
    ['/:id', [], ePrescriptionController.getPrescription],
    ['/:id/safety', [], ePrescriptionController.getPrescriptionSafety]
  ],
  put: [
    ['/:id', [rejectMobileClinicalWrite], ePrescriptionController.updatePrescription]
  ],
  post: [
    ['/:id/sign', [rejectMobileClinicalWrite], ePrescriptionController.signPrescription],
    ['/:id/order-pharmacy',
      [rejectMobileClinicalWrite, requireIdempotencyKey({ required: false, scope: 'prescription_order_pharmacy' })],
      ePrescriptionController.orderPharmacyFromPrescription],
    ['/:id/refill',
      [rejectMobileClinicalWrite, requireIdempotencyKey({ required: false, scope: 'prescription_refill' })],
      ePrescriptionController.orderPharmacyFromPrescription]
  ]
});

export default router;
