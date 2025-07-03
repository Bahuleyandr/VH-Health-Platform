// utils/infrastructure/swaggerUtils.js
import YAML from 'yamljs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../../logging/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Swagger document
export const loadSwaggerDocument = () => {
  let swaggerDocument = null;
  let loadError = null;
  
  try {
    const swaggerPath = path.join(__dirname, '../../docs/swagger.yaml');
    
    if (fs.existsSync(swaggerPath)) {
      swaggerDocument = YAML.load(swaggerPath);
      logger.info('✅ Swagger documentation loaded successfully from swagger.yaml');
    } else {
      throw new Error('swagger.yaml file not found');
    }
  } catch (err) {
    loadError = err.message;
    logger.warn(`⚠️ Could not load swagger.yaml: ${err.message}. Using fallback documentation.`);
    swaggerDocument = generateFallbackSwagger();
  }
  
  return { swaggerDocument, loadError };
};

// Generate fallback Swagger document
export const generateFallbackSwagger = () => {
  return {
    openapi: '3.0.3',
    info: {
      title: 'VH Health API',
      version: '2.0.0',
      description: 'VH Health - Comprehensive Healthcare Management System',
      termsOfService: 'https://vh-health.com/terms',
      contact: {
        name: 'VH Health API Support',
        url: 'https://vh-health.com/support',
        email: 'api-support@vh-health.com'
      },
      license: {
        name: 'VH Health License',
        url: 'https://vh-health.com/license'
      }
    },
    servers: [
      { 
        url: 'https://vh-health-backend.onrender.com/api/v1',
        description: 'Production Server'
      },
      {
        url: 'http://localhost:5000/api/v1', 
        description: 'Development Server'
      }
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key'
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    },
    security: [
      { ApiKeyAuth: [] },
      { BearerAuth: [] }
    ],
    tags: [],
    paths: {}
  };
};

// Analyze Swagger document
export const analyzeSwaggerDocument = (swaggerDocument) => {
  const paths = swaggerDocument.paths || {};
  const methods = {};
  const tags = {};
  let totalEndpoints = 0;
  let securedEndpoints = 0;
  let documentedEndpoints = 0;
  let deprecatedEndpoints = 0;
  
  Object.entries(paths).forEach(([path, pathObj]) => {
    Object.entries(pathObj).forEach(([method, operation]) => {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        // Count by method
        methods[method] = (methods[method] || 0) + 1;
        totalEndpoints++;
        
        // Count by tags
        if (operation.tags) {
          operation.tags.forEach(tag => {
            tags[tag] = (tags[tag] || 0) + 1;
          });
        }
        
        // Count secured endpoints
        if (operation.security || swaggerDocument.security) {
          securedEndpoints++;
        }
        
        // Count documented endpoints
        if (operation.summary || operation.description) {
          documentedEndpoints++;
        }
        
        // Count deprecated endpoints
        if (operation.deprecated) {
          deprecatedEndpoints++;
        }
      }
    });
  });
  
  return {
    overview: {
      totalEndpoints,
      totalPaths: Object.keys(paths).length,
      securedEndpoints,
      documentedEndpoints,
      deprecatedEndpoints,
      securityCoverage: totalEndpoints > 0 ? Math.round((securedEndpoints / totalEndpoints) * 100) : 0,
      documentationCoverage: totalEndpoints > 0 ? Math.round((documentedEndpoints / totalEndpoints) * 100) : 0
    },
    methodBreakdown: methods,
    tagBreakdown: tags,
    authentication: {
      hasAuthentication: !!(swaggerDocument.components?.securitySchemes),
      authMethods: Object.keys(swaggerDocument.components?.securitySchemes || {}),
      globalSecurity: !!(swaggerDocument.security && swaggerDocument.security.length > 0)
    },
    infrastructure: {
      serverCount: (swaggerDocument.servers || []).length,
      hasComponents: !!(swaggerDocument.components),
      hasSchemas: !!(swaggerDocument.components?.schemas),
      schemaCount: Object.keys(swaggerDocument.components?.schemas || {}).length
    }
  };
};

// Validate Swagger document
export const validateSwaggerDocument = (swaggerDocument, strict = false) => {
  const validation = {
    valid: true,
    errors: [],
    warnings: [],
    checks: {}
  };
  
  // Essential validation checks
  validation.checks.hasOpenAPIVersion = !!swaggerDocument.openapi;
  validation.checks.hasTitle = !!(swaggerDocument.info?.title);
  validation.checks.hasVersion = !!(swaggerDocument.info?.version);
  validation.checks.hasPaths = !!(swaggerDocument.paths && Object.keys(swaggerDocument.paths).length > 0);
  validation.checks.hasServers = !!(swaggerDocument.servers && swaggerDocument.servers.length > 0);
  validation.checks.hasSecurity = !!(swaggerDocument.components?.securitySchemes);
  
  // Critical errors
  if (!validation.checks.hasOpenAPIVersion) {
    validation.errors.push('Missing OpenAPI version specification');
    validation.valid = false;
  }
  
  if (!validation.checks.hasTitle) {
    validation.errors.push('Missing API title in info section');
    validation.valid = false;
  }
  
  if (!validation.checks.hasVersion) {
    validation.errors.push('Missing API version in info section');
    validation.valid = false;
  }
  
  // Warnings for best practices
  if (!validation.checks.hasPaths) {
    validation.warnings.push('No API paths defined - documentation may be incomplete');
  }
  
  if (!validation.checks.hasServers) {
    validation.warnings.push('No servers defined - clients may not know where to connect');
  }
  
  if (!validation.checks.hasSecurity) {
    validation.warnings.push('No security schemes defined - API may lack authentication');
  }
  
  if (!swaggerDocument.info?.description) {
    validation.warnings.push('Missing API description for better documentation');
  }
  
  if (!swaggerDocument.info?.contact) {
    validation.warnings.push('Missing contact information for API support');
  }
  
  // Strict validation
  if (strict) {
    const paths = swaggerDocument.paths || {};
    let undocumentedEndpoints = 0;
    let missingExamples = 0;
    
    Object.values(paths).forEach(pathObj => {
      Object.values(pathObj).forEach(operation => {
        if (typeof operation === 'object') {
          if (!operation.summary && !operation.description) {
            undocumentedEndpoints++;
          }
          if (!operation.responses) {
            validation.errors.push('Endpoint missing response definitions');
          }
          if (operation.requestBody && !operation.requestBody.content) {
            missingExamples++;
          }
        }
      });
    });
    
    if (undocumentedEndpoints > 0) {
      validation.warnings.push(`${undocumentedEndpoints} endpoints lack proper documentation`);
    }
    
    if (missingExamples > 0) {
      validation.warnings.push(`${missingExamples} request bodies lack examples`);
    }
  }
  
  return validation;
};

// Get Swagger UI options
export const getSwaggerUIOptions = () => {
  return {
    customSiteTitle: 'VH Health API Documentation - Comprehensive Healthcare Platform',
    customfavIcon: '/favicon.ico',
    customCss: `
      .swagger-ui .topbar { 
        background-color: #2c5aa0; 
        border-bottom: 3px solid #1e3d6f;
      }
      .swagger-ui .topbar .download-url-wrapper { display: none; }
      .swagger-ui .info .title { 
        color: #2c5aa0; 
        font-size: 2.5rem;
        font-weight: bold;
      }
      .swagger-ui .info .description { 
        font-size: 1.1rem; 
        line-height: 1.6;
      }
      .swagger-ui .scheme-container { 
        background: linear-gradient(135deg, #f7f7f7 0%, #e8f4f8 100%); 
        padding: 20px; 
        border-radius: 8px;
        border: 1px solid #ddd;
        margin: 15px 0;
      }
      .swagger-ui .opblock.opblock-post { border-color: #49cc90; }
      .swagger-ui .opblock.opblock-get { border-color: #61affe; }
      .swagger-ui .opblock.opblock-put { border-color: #fca130; }
      .swagger-ui .opblock.opblock-delete { border-color: #f93e3e; }
      .swagger-ui .btn.authorize { 
        background-color: #2c5aa0; 
        border-color: #2c5aa0;
      }
      .swagger-ui .btn.authorize:hover { 
        background-color: #1e3d6f; 
      }
    `,
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      docExpansion: 'list',
      filter: true,
      showExtensions: true,
      showCommonExtensions: true,
      defaultModelsExpandDepth: 3,
      defaultModelExpandDepth: 2,
      displayOperationId: false,
      tryItOutEnabled: true
    },
    explorer: true
  };
};