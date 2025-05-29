// src/routes/lookupRoutes.js

import express from 'express';
import * as userController from '../controllers/userController.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';

const router = express.Router();

// ✅ GET /api/v1/lookup?phone=... or ?uid=... or ?name=...
wrapAutoRBAC(
  router,
  'lookupRoutes',
  {
    get: [['/', userController.lookupUser]]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

export default router;
