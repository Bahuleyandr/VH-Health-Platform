// src/routes/swaggerRoutes.js - Complete API Documentation Routes

import express from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import path from 'path';
import { fileURLToPath } from 'url';
import { wrapRoutes } from '../config/routeWrapper.js';
import { success } from '../utils/responseHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Load Swagger YAML
let swaggerDocument;
try {
  swaggerDocument = YAML.load(path.join(__dirname, '../docs/swagger.yaml'));
} catch (err) {
  console.warn('Could not load swagger.yaml, using basic documentation');
  swaggerDocument = {
    openapi: '3.0.0',
    info: {
      title: 'VH Health API',
      version: '1.0.0',
      description: 'Healthcare Management System API - Complete medical platform with patient management, appointments, emergency services, and analytics.'
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
    paths: {
      '/health': {
        get: {
          summary: 'Health Check',
          description: 'Check if the API is running and healthy',
          responses: {
            200: { description: 'API is healthy' }
          }
        }
      },
      '/auth/request-otp': {
        post: {
          summary: 'Request OTP',
          description: 'Request an OTP for authentication',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    phone: { type: 'string', example: '9876543210' },
                    purpose: { type: 'string', example: 'login' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'OTP sent successfully' }
          }
        }
      },
      '/users': {
        get: {
          summary: 'List Users',
          description: 'Get paginated list of users',
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          responses: {
            200: { description: 'Users retrieved successfully' }
          }
        },
        post: {
          summary: 'Create User',
          description: 'Create a new user profile',
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          responses: {
            200: { description: 'User created successfully' }
          }
        }
      },
      '/appointments': {
        get: {
          summary: 'List Appointments',
          description: 'Get user appointments',
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          responses: {
            200: { description: 'Appointments retrieved successfully' }
          }
        },
        post: {
          summary: 'Book Appointment',
          description: 'Book a new appointment',
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          responses: {
            200: { description: 'Appointment booked successfully' }
          }
        }
      },
      '/sos': {
        post: {
          summary: 'Emergency SOS Alert',
          description: 'Send emergency alert with location',
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          responses: {
            200: { description: 'Emergency alert sent successfully' }
          }
        }
      }
    }
  };
}

// ✅ Swagger Documentation Routes
wrapRoutes(
  router,
  [],
  {
    get: [
      // 📚 Swagger UI Documentation
      [
        '/',
        ...swaggerUi.serve,
        swaggerUi.setup(swaggerDocument, {
          customSiteTitle: 'VH Health API Documentation',
          customCss: `
            .swagger-ui .topbar { display: none }
            .swagger-ui .info .title { color: #2c5aa0; }
            .swagger-ui .scheme-container { background: #f7f7f7; padding: 15px; }
          `,
          swaggerOptions: {
            persistAuthorization: true,
            displayRequestDuration: true,
            docExpansion: 'list',
            filter: true,
            showExtensions: true,
            showCommonExtensions: true,
            defaultModelsExpandDepth: 2
          },
          customCssUrl: null,
          customJs: null,
          explorer: true
        })
      ],

      // 📄 Raw OpenAPI Spec (JSON)
      [
        '/spec',
        (req, res) => {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.json(swaggerDocument);
        }
      ],

      // 📄 Raw OpenAPI Spec (YAML)
      [
        '/spec.yaml',
        (req, res) => {
          res.setHeader('Content-Type', 'text/yaml');
          res.setHeader('Access-Control-Allow-Origin', '*');
          
          try {
            const yamlString = YAML.stringify(swaggerDocument, 4);
            res.send(yamlString);
          } catch (err) {
            res.status(500).json({ error: 'Failed to generate YAML spec' });
          }
        }
      ],

      // 📊 API Documentation Statistics
      [
        '/stats',
        (req, res) => {
          try {
            const paths = swaggerDocument.paths || {};
            const methods = {};
            let totalEndpoints = 0;

            // Count endpoints by HTTP method
            Object.values(paths).forEach(pathObj => {
              Object.keys(pathObj).forEach(method => {
                if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
                  methods[method] = (methods[method] || 0) + 1;
                  totalEndpoints++;
                }
              });
            });

            const stats = {
              totalEndpoints,
              totalPaths: Object.keys(paths).length,
              methodBreakdown: methods,
              apiVersion: swaggerDocument.info?.version || '1.0.0',
              title: swaggerDocument.info?.title || 'API',
              description: swaggerDocument.info?.description || '',
              lastUpdated: new Date().toISOString(),
              specVersion: swaggerDocument.openapi || '3.0.0',
              hasAuthentication: !!(swaggerDocument.components?.securitySchemes),
              authMethods: Object.keys(swaggerDocument.components?.securitySchemes || {}),
              serverCount: (swaggerDocument.servers || []).length,
              servers: swaggerDocument.servers || [],
              hasComponents: !!(swaggerDocument.components),
              hasSchemas: !!(swaggerDocument.components?.schemas),
              hasSecurity: !!(swaggerDocument.security)
            };

            success(res, stats, 'API documentation statistics retrieved');
          } catch (err) {
            res.status(500).json({ 
              error: 'Failed to generate documentation statistics',
              details: err.message 
            });
          }
        }
      ],

      // 🔍 Validate OpenAPI Specification
      [
        '/validate',
        (req, res) => {
          try {
            const validation = {
              valid: true,
              errors: [],
              warnings: [],
              info: {}
            };

            // Basic validation checks
            if (!swaggerDocument.openapi) {
              validation.errors.push('Missing OpenAPI version');
              validation.valid = false;
            }

            if (!swaggerDocument.info?.title) {
              validation.errors.push('Missing API title');
              validation.valid = false;
            }

            if (!swaggerDocument.info?.version) {
              validation.errors.push('Missing API version');
              validation.valid = false;
            }

            if (!swaggerDocument.paths || Object.keys(swaggerDocument.paths).length === 0) {
              validation.warnings.push('No API paths defined');
            }

            if (!swaggerDocument.components?.securitySchemes) {
              validation.warnings.push('No security schemes defined');
            }

            // Info about the spec
            validation.info = {
              pathCount: Object.keys(swaggerDocument.paths || {}).length,
              hasServers: !!(swaggerDocument.servers && swaggerDocument.servers.length > 0),
              hasComponents: !!swaggerDocument.components,
              specFormat: 'OpenAPI 3.0'
            };

            const status = validation.valid ? 'valid' : 'invalid';
            const message = validation.valid 
              ? 'OpenAPI specification is valid'
              : `OpenAPI specification has ${validation.errors.length} error(s)`;

            success(res, {
              status,
              validation,
              validatedAt: new Date().toISOString()
            }, message);

          } catch (err) {
            res.status(500).json({
              status: 'error',
              error: 'Failed to validate OpenAPI specification',
              details: err.message
            });
          }
        }
      ],

      // 📋 API Health Summary
      [
        '/health',
        (req, res) => {
          try {
            const health = {
              status: 'healthy',
              documentation: {
                available: true,
                format: 'OpenAPI 3.0',
                uiAvailable: true,
                specFormats: ['JSON', 'YAML']
              },
              endpoints: {
                total: Object.keys(swaggerDocument.paths || {}).length,
                documented: true,
                authRequired: !!(swaggerDocument.security && swaggerDocument.security.length > 0)
              },
              metadata: {
                title: swaggerDocument.info?.title,
                version: swaggerDocument.info?.version,
                lastModified: new Date().toISOString()
              }
            };

            success(res, health, 'API documentation health check');
          } catch (err) {
            res.status(500).json({
              status: 'unhealthy',
              error: 'Documentation health check failed',
              details: err.message
            });
          }
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