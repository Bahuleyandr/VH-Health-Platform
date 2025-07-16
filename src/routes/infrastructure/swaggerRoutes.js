// routes/infrastructure/swaggerRoutes.js
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { wrapRoutes, wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as swaggerController from '../../controllers/infrastructure/swaggerController.js';
import { SwaggerService } from '../../services/infrastructure/swaggerService.js';
import { getSwaggerUIOptions } from '../../utils/infrastructure/swaggerUtils.js';
import { 
  statsQueryValidator, 
  validationQueryValidator, 
  discoveryQueryValidator,
  regenerateDocValidator,
  analyticsQueryValidator 
} from '../../validators/infrastructure/swaggerValidator.js';

const router = express.Router();

// Get Swagger document
const { swaggerDocument } = SwaggerService.getSwaggerDocument();
const swaggerUIOptions = getSwaggerUIOptions();

// 📚 PUBLIC DOCUMENTATION ROUTES
wrapRoutes(
  router,
  [],
  {
    get: [
      // 📖 Main Swagger UI Documentation
      [
        '/',
        ...swaggerUi.serve,
        swaggerUi.setup(swaggerDocument, swaggerUIOptions)
      ],
      
      // 📄 Raw OpenAPI Specification (JSON)
      ['/spec', swaggerController.getSpecJSON],
      
      // 📄 Raw OpenAPI Specification (YAML)
      ['/spec.yaml', swaggerController.getSpecYAML],
      
      // 📊 API Documentation Statistics
      ['/stats', statsQueryValidator, swaggerController.getStats],
      
      // 🔍 Validate OpenAPI Specification
      ['/validate', validationQueryValidator, swaggerController.validateSpec],
      
      // 📋 API Documentation Health Check
      ['/health', swaggerController.getDocHealth],
      
      // 🔗 API Endpoint Discovery
      ['/discover', discoveryQueryValidator, swaggerController.discoverEndpoints]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipRBAC: true
  }
);

// 🔧 ADMIN DOCUMENTATION MANAGEMENT
wrapAutoRBAC(
  router, 
  'adminDocumentationRoutes',
  {
    get: [
      // 📊 Documentation Usage Analytics
      ['/admin/analytics', analyticsQueryValidator, swaggerController.getAnalytics]
    ],
    
    post: [
      // 🔄 Regenerate Documentation
      ['/admin/regenerate', regenerateDocValidator, swaggerController.regenerateDoc]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

export default router;