// src/routes/record/index.js
import express from 'express';
import { wrapAutoRBAC, wrapRoutesWithValidation } from '../../config/routeWrapper.js';
import patientRoutes from './patientRoutes.js';
import medicalStaffRoutes from './medicalStaffRoutes.js';
import doctorRoutes from './doctorRoutes.js';
import adminRoutes from './adminRoutes.js';
import { VALID_RECORD_TYPES } from '../../config/recordConfig.js';

const router = express.Router();
console.log('✅ Enhanced recordRoutes loaded');

// Public test route
wrapRoutesWithValidation(
  router,
  [],
  {
    get: [
      [
        '/test',
        [],
        (req, res) => {
          res.json({ 
            message: 'Enhanced Medical Records routes working!',
            timestamp: new Date().toLocaleDateString('en-GB'),
            version: '3.0.0-enhanced',
            features: [
              'RBAC Protection', 'HIPAA Compliance', 'Privacy Levels', 
              'Audit Logging', 'Role-based Access', 'Medical Record Management'
            ],
            recordTypes: VALID_RECORD_TYPES
          });
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

// Patient routes (PATIENT, NURSING_STAFF, DOCTOR, ADMIN)
wrapAutoRBAC(patientRoutes, 'recordRoutes');
router.use('/', patientRoutes);

// Medical Staff routes (DOCTOR, NURSING_STAFF, LAB_STAFF, ADMIN)
wrapAutoRBAC(medicalStaffRoutes, 'medicalStaffRoutes');
router.use('/', medicalStaffRoutes);

// Doctor routes (DOCTOR, ADMIN)
wrapAutoRBAC(doctorRoutes, 'doctorRoutes');
router.use('/', doctorRoutes);

// Admin routes (ADMIN only)
wrapAutoRBAC(adminRoutes, 'adminRecordRoutes');
router.use('/', adminRoutes);

export default router;