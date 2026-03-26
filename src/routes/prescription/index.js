import express from 'express';
import multer from 'multer';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as ePrescriptionController from '../../controllers/prescription/ePrescriptionController.js';
import logger from '../../logging/logger.js';

const router = express.Router();

logger.info('✅ E-Prescription routes loaded');

// Multer for handwritten prescription photo
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only images and PDFs are allowed'));
    }
  }
});

// Static paths BEFORE /:id

// Staff/admin create prescription
wrapAutoRBAC(router, 'ePrescriptionCreateRoutes', {
  post: [
    ['/create', [upload.single('handwritten_photo')], ePrescriptionController.createPrescription]
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

// Dynamic /:id routes last
wrapAutoRBAC(router, 'ePrescriptionDetailRoutes', {
  get: [
    ['/:id', [], ePrescriptionController.getPrescription]
  ],
  post: [
    ['/:id/order-pharmacy', [], ePrescriptionController.orderPharmacyFromPrescription]
  ]
});

export default router;
