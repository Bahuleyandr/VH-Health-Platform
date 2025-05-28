import express from 'express';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import * as doctorController from '../controllers/doctorController.js';

const router = express.Router();

/**
 * ✅ Doctor Routes (RBAC-controlled via `doctorRoutes`)
 * - List doctors or search by name/specialty
 * - Fetch doctor by ID
 * - Add doctor (admin)
 * - Delete doctor (admin)
 */
wrapAutoRBAC(router, 'doctorRoutes', {
  get: [
    ['/', doctorController.getAllDoctors],
    ['/:doctorId', doctorController.getDoctorById],
  ],
  post: [['/', doctorController.addDoctor]],
  delete: [['/:doctorId', doctorController.deleteDoctor]],
});

export default router;
