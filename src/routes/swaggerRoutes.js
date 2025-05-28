// src/routes/swaggerRoutes.js

import express from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import path from 'path';
import { fileURLToPath } from 'url';
import { wrapRoutes } from '../config/routeWrapper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Load Swagger YAML
const swaggerDocument = YAML.load(path.join(__dirname, '../docs/swagger.yaml'));

// ✅ Public Swagger UI route with audit logging
wrapRoutes(
  router,
  [],
  {
    get: [['/', swaggerUi.serve, swaggerUi.setup(swaggerDocument)]],
  },
  {
    requireUID: false,
    requirePhone: false,
  },
);

export default router;
