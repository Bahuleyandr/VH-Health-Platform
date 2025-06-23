import express from 'express';
import { success } from '../utils/responseHelper.js';
import { wrapRoutes } from '../config/routeWrapper.js';

const router = express.Router();

// ✅ Public Version Info Route (No UID/Phone check, No RBAC)
wrapRoutes(
  router,
  [],
  {
    get: [
      [
        '/',
        (req, res) => {
          const versionInfo = {
            version: '1.0.0',
            updated_at: '2025-05-12',
            message: 'VH Health API Version 1.0.0 - Initial Release'
          };

          success(res, versionInfo, 'App version fetched successfully');
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

export default router;
