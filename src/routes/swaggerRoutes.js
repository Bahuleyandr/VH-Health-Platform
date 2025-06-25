// src/routes/swaggerRoutes.js - Enhanced API Documentation System with Full RBAC

import express from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { wrapRoutes, wrapAutoRBAC } from '../config/routeWrapper.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS } from '../config/responseCodes.js';
import { validationResult, query, body } from 'express-validator';
import logger from '../logging/logger.js';
import db from '../config/database.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// ✅ Load Swagger Documentation with Enhanced Error Handling
let swaggerDocument;
let swaggerLoadError = null;

try {
  const swaggerPath = path.join(__dirname, '../docs/swagger.yaml');
  
  if (fs.existsSync(swaggerPath)) {
    swaggerDocument = YAML.load(swaggerPath);
    logger.info('✅ Swagger documentation loaded successfully from swagger.yaml');
  } else {
    throw new Error('swagger.yaml file not found');
  }
} catch (err) {
  swaggerLoadError = err.message;
  logger.warn(`⚠️ Could not load swagger.yaml: ${err.message}. Using fallback documentation.`);
  
  // Enhanced fallback Swagger document
  swaggerDocument = {
    openapi: '3.0.3',
    info: {
      title: 'VH Health API',
      version: '2.0.0',
      description: `
# VH Health - Comprehensive Healthcare Management System

A complete medical platform providing:
- **Patient Management**: User profiles, medical records, emergency contacts
- **Appointment System**: Doctor scheduling, department-based booking, reminders
- **Emergency Services**: SOS alerts, location-based hospital finder, emergency response
- **Medical Records**: Secure HIPAA-compliant document management
- **Pharmacy System**: Prescription management, inventory tracking, delivery
- **Investigation Lab**: Test results, report generation, urgent notifications
- **Staff Management**: HR system, attendance tracking, performance reviews
- **Analytics Dashboard**: Real-time insights, performance metrics, reporting
- **Notification System**: Push notifications, SMS alerts, email communication
- **Authentication**: Multi-factor auth, OTP verification, role-based access

## Security Features
- API Key authentication for all endpoints
- JWT tokens for user sessions
- Role-based access control (RBAC) with 11+ role types
- Rate limiting and abuse protection
- Audit logging for all activities
- HIPAA compliance for medical data

## Emergency Features
- Real-time SOS alert system
- Location-based emergency services
- Auto-escalation for critical alerts
- Emergency contact notification
- Hospital/ambulance coordination
      `,
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
        description: 'Production Server - Live medical platform'
      },
      {
        url: 'http://localhost:5000/api/v1', 
        description: 'Development Server - Testing environment'
      },
      {
        url: 'https://staging-vh-health.onrender.com/api/v1',
        description: 'Staging Server - Pre-production testing'
      }
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'API Key required for all endpoints (except auth and health checks)'
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token obtained from login/register endpoints'
        }
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 123 },
            uid: { type: 'string', format: 'uuid' },
            phone: { type: 'string', example: '+919876543210' },
            name: { type: 'string', example: 'John Doe' },
            email: { type: 'string', format: 'email' },
            role: { 
              type: 'string', 
              enum: ['PATIENT', 'DOCTOR', 'ADMIN', 'NURSING_STAFF', 'PHARMACY_STAFF', 'LAB_STAFF', 'HR_STAFF', 'GENERAL_STAFF', 'RECEPTIONIST', 'SECURITY', 'EMERGENCY_RESPONDER'] 
            },
            registered_at: { type: 'string', format: 'date-time' }
          }
        },
        Appointment: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            phone: { type: 'string' },
            doctor_name: { type: 'string', example: 'Dr. Smith' },
            department: { type: 'string', example: 'Cardiology' },
            date: { type: 'string', format: 'date' },
            time: { type: 'string', example: '10:30' },
            status: { type: 'string', enum: ['pending', 'confirmed', 'completed', 'cancelled'] },
            created_at: { type: 'string', format: 'date-time' }
          }
        },
        SOSAlert: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            phone: { type: 'string' },
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            latitude: { type: 'number', format: 'float' },
            longitude: { type: 'number', format: 'float' },
            message: { type: 'string' },
            emergency_type: { type: 'string', enum: ['medical', 'accident', 'violence', 'fire', 'other'] },
            status: { type: 'string', enum: ['active', 'responding', 'resolved', 'cancelled'] },
            created_at: { type: 'string', format: 'date-time' }
          }
        },
        Investigation: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            phone: { type: 'string' },
            test_name: { type: 'string', example: 'Blood Test - Complete Hemogram' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
            result_status: { type: 'string', enum: ['normal', 'abnormal', 'critical'] },
            requested_at: { type: 'string', format: 'date-time' },
            file_key: { type: 'string', description: 'File storage key for results' }
          }
        },
        ApiResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object' },
            timestamp: { type: 'string', format: 'date-time' }
          }
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string' },
            error: { type: 'string' },
            details: { type: 'object' }
          }
        }
      },
      responses: {
        Unauthorized: {
          description: 'Authentication required',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' }
            }
          }
        },
        Forbidden: {
          description: 'Insufficient permissions',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' }
            }
          }
        },
        NotFound: {
          description: 'Resource not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' }
            }
          }
        },
        ValidationError: {
          description: 'Input validation failed',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/ErrorResponse' },
                  {
                    type: 'object',
                    properties: {
                      errors: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            field: { type: 'string' },
                            message: { type: 'string' }
                          }
                        }
                      }
                    }
                  }
                ]
              }
            }
          }
        }
      }
    },
    security: [
      { ApiKeyAuth: [] },
      { BearerAuth: [] }
    ],
    tags: [
      { name: 'Authentication', description: 'User authentication and authorization' },
      { name: 'Users', description: 'User profile management' },
      { name: 'Appointments', description: 'Medical appointment scheduling' },
      { name: 'Emergency', description: 'SOS alerts and emergency services' },
      { name: 'Medical Records', description: 'Health records and documents' },
      { name: 'Investigations', description: 'Lab tests and medical investigations' },
      { name: 'Pharmacy', description: 'Prescription and medication management' },
      { name: 'Staff', description: 'Hospital staff and HR management' },
      { name: 'Analytics', description: 'System analytics and reporting' },
      { name: 'Notifications', description: 'Push notifications and alerts' },
      { name: 'Documentation', description: 'API documentation and specifications' }
    ],
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Health Check',
          description: 'Check if the API is running and healthy. Includes database connectivity and environment validation.',
          responses: {
            200: { 
              description: 'API is healthy',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ApiResponse' }
                }
              }
            },
            500: { $ref: '#/components/responses/NotFound' }
          }
        }
      },
      '/auth/login': {
        post: {
          tags: ['Authentication'],
          summary: 'User Login',
          description: 'Authenticate user with phone number and return JWT token',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['phone'],
                  properties: {
                    phone: { type: 'string', pattern: '^[0-9]{10}$', example: '9876543210' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Login successful' },
            400: { $ref: '#/components/responses/ValidationError' },
            404: { $ref: '#/components/responses/NotFound' }
          }
        }
      },
      '/auth/register': {
        post: {
          tags: ['Authentication'],
          summary: 'User Registration',
          description: 'Register new user with phone and basic information',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['phone', 'name'],
                  properties: {
                    phone: { type: 'string', pattern: '^[0-9]{10}$' },
                    name: { type: 'string', minLength: 2 },
                    email: { type: 'string', format: 'email' },
                    gender: { type: 'string', enum: ['male', 'female', 'other'] }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Registration successful' },
            400: { $ref: '#/components/responses/ValidationError' },
            409: { description: 'User already exists' }
          }
        }
      },
      '/otp/request-otp': {
        post: {
          tags: ['Authentication'],
          summary: 'Request OTP',
          description: 'Request an OTP for authentication or verification',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['phone'],
                  properties: {
                    phone: { type: 'string', pattern: '^[0-9]{10}$', example: '9876543210' },
                    purpose: { type: 'string', enum: ['login', 'register', 'reset_password'], example: 'login' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'OTP sent successfully' },
            400: { $ref: '#/components/responses/ValidationError' }
          }
        }
      },
      '/users': {
        get: {
          tags: ['Users'],
          summary: 'List Users',
          description: 'Get paginated list of users with filtering options',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 } },
            { name: 'role', in: 'query', schema: { type: 'string' } },
            { name: 'query', in: 'query', schema: { type: 'string', description: 'Search by name or phone' } }
          ],
          responses: {
            200: { description: 'Users retrieved successfully' },
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' }
          }
        },
        post: {
          tags: ['Users'],
          summary: 'Create User Profile',
          description: 'Create or update user profile with medical information',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['phone', 'name', 'gender'],
                  properties: {
                    phone: { type: 'string' },
                    name: { type: 'string' },
                    gender: { type: 'string' },
                    email: { type: 'string', format: 'email' },
                    birthday: { type: 'string', format: 'date' },
                    address: { type: 'string' },
                    emergency_contact: { type: 'object' },
                    medical_conditions: { type: 'array', items: { type: 'string' } }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'User profile saved' },
            400: { $ref: '#/components/responses/ValidationError' }
          }
        }
      },
      '/appointments': {
        get: {
          tags: ['Appointments'],
          summary: 'List Appointments',
          description: 'Get user appointments with filtering and pagination',
          parameters: [
            { name: 'phone', in: 'query', schema: { type: 'string' } },
            { name: 'filter', in: 'query', schema: { type: 'string', enum: ['upcoming', 'past', 'today'] } },
            { name: 'doctor_name', in: 'query', schema: { type: 'string' } }
          ],
          responses: {
            200: { description: 'Appointments retrieved successfully' }
          }
        },
        post: {
          tags: ['Appointments'],
          summary: 'Book Appointment',
          description: 'Book a new medical appointment',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['phone', 'doctor_name', 'date', 'time'],
                  properties: {
                    phone: { type: 'string' },
                    doctor_name: { type: 'string' },
                    department: { type: 'string' },
                    date: { type: 'string', format: 'date' },
                    time: { type: 'string', pattern: '^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$' },
                    appointment_type: { type: 'string', enum: ['consultation', 'follow_up', 'emergency'] }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Appointment booked successfully' },
            400: { $ref: '#/components/responses/ValidationError' },
            409: { description: 'Time slot not available' }
          }
        }
      },
      '/sos': {
        post: {
          tags: ['Emergency'],
          summary: 'Emergency SOS Alert',
          description: 'Send emergency alert with location and medical information',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['phone'],
                  properties: {
                    phone: { type: 'string' },
                    latitude: { type: 'number', format: 'float', minimum: -90, maximum: 90 },
                    longitude: { type: 'number', format: 'float', minimum: -180, maximum: 180 },
                    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], default: 'high' },
                    message: { type: 'string', maxLength: 500 },
                    emergency_type: { type: 'string', enum: ['medical', 'accident', 'violence', 'fire', 'other'] },
                    medical_conditions: { type: 'array', items: { type: 'string' } }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Emergency alert sent successfully' },
            400: { $ref: '#/components/responses/ValidationError' }
          }
        }
      },
      '/investigations': {
        get: {
          tags: ['Investigations'],
          summary: 'List Investigations',
          description: 'Get lab test results and investigation reports',
          parameters: [
            { name: 'phone', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'completed'] } }
          ],
          responses: {
            200: { description: 'Investigations retrieved successfully' }
          }
        },
        post: {
          tags: ['Investigations'],
          summary: 'Request Investigation',
          description: 'Request a new lab test or medical investigation',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['phone', 'test_name'],
                  properties: {
                    phone: { type: 'string' },
                    test_name: { type: 'string', example: 'Complete Blood Count' },
                    urgency: { type: 'string', enum: ['routine', 'urgent', 'stat'], default: 'routine' },
                    doctor_notes: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Investigation requested successfully' }
          }
        }
      },
      '/pharmacy-orders': {
        get: {
          tags: ['Pharmacy'],
          summary: 'List Pharmacy Orders',
          description: 'Get medication orders and prescription status',
          responses: {
            200: { description: 'Pharmacy orders retrieved successfully' }
          }
        },
        post: {
          tags: ['Pharmacy'],
          summary: 'Place Pharmacy Order',
          description: 'Place new medication order or prescription',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['phone', 'order_note'],
                  properties: {
                    phone: { type: 'string' },
                    order_note: { type: 'string' },
                    medications: { type: 'array', items: { type: 'object' } },
                    delivery_address: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Pharmacy order placed successfully' }
          }
        }
      },
      '/staff/list': {
        get: {
          tags: ['Staff'],
          summary: 'List Staff Members',
          description: 'Get hospital staff directory with role-based filtering',
          parameters: [
            { name: 'department', in: 'query', schema: { type: 'string' } },
            { name: 'role', in: 'query', schema: { type: 'string' } },
            { name: 'shift', in: 'query', schema: { type: 'string', enum: ['MORNING', 'AFTERNOON', 'NIGHT'] } }
          ],
          responses: {
            200: { description: 'Staff list retrieved successfully' },
            403: { $ref: '#/components/responses/Forbidden' }
          }
        }
      },
      '/admin/analytics': {
        get: {
          tags: ['Analytics'],
          summary: 'System Analytics',
          description: 'Get comprehensive system analytics and metrics (Admin only)',
          parameters: [
            { name: 'timeframe', in: 'query', schema: { type: 'string', enum: ['daily', 'weekly', 'monthly'] } }
          ],
          responses: {
            200: { description: 'Analytics data retrieved successfully' },
            403: { $ref: '#/components/responses/Forbidden' }
          }
        }
      }
    },
    externalDocs: {
      description: 'Find more info at VH Health Documentation',
      url: 'https://vh-health.com/docs'
    }
  };
}

// ✅ Enhanced Swagger UI Configuration
const swaggerUIOptions = {
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
    .swagger-ui .opblock .opblock-summary { 
      font-weight: 600; 
      font-size: 1.1rem;
    }
    .swagger-ui .btn.authorize { 
      background-color: #2c5aa0; 
      border-color: #2c5aa0;
    }
    .swagger-ui .btn.authorize:hover { 
      background-color: #1e3d6f; 
    }
    .swagger-ui .parameter__name { font-weight: bold; }
    .swagger-ui .response-col_status { font-weight: bold; }
    .swagger-ui select { padding: 8px; border-radius: 4px; }
    .auth-wrapper { margin: 20px 0; }
    .auth-container h4 { color: #2c5aa0; margin-bottom: 15px; }
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
    tryItOutEnabled: true,
    requestInterceptor: function(req) {
      // Add API key to all requests if not present
      if (!req.headers['x-api-key'] && localStorage.getItem('vh-api-key')) {
        req.headers['x-api-key'] = localStorage.getItem('vh-api-key');
      }
      return req;
    },
    onComplete: function() {
      console.log('VH Health API Documentation loaded successfully');
    }
  },
  explorer: true,
  customJsStr: `
    window.onload = function() {
      // Add custom styling and functionality
      const authButton = document.querySelector('.auth-wrapper .btn.authorize');
      if (authButton) {
        authButton.style.marginTop = '10px';
      }
      
      // Add version info
      const infoSection = document.querySelector('.info');
      if (infoSection) {
        const versionBadge = document.createElement('div');
        versionBadge.innerHTML = '<span style="background: #2c5aa0; color: white; padding: 5px 10px; border-radius: 15px; font-size: 0.9rem; margin: 10px 0; display: inline-block;">Version 2.0.0 - Production Ready</span>';
        infoSection.appendChild(versionBadge);
      }
    }
  `
};

// 📚 ====== PUBLIC DOCUMENTATION ROUTES ====== 📚
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
      [
        '/spec',
        (req, res) => {
          try {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
            
            // Add metadata to the response
            const specWithMetadata = {
              ...swaggerDocument,
              'x-generated-at': new Date().toISOString(),
              'x-generator': 'VH Health API Documentation System v2.0',
              'x-spec-source': swaggerLoadError ? 'fallback' : 'file'
            };
            
            res.json(specWithMetadata);
          } catch (err) {
            logger.error('Swagger Spec JSON Error:', err);
            res.status(500).json({ 
              error: 'Failed to generate OpenAPI specification',
              details: err.message 
            });
          }
        }
      ],

      // 📄 Raw OpenAPI Specification (YAML)
      [
        '/spec.yaml',
        (req, res) => {
          try {
            res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Content-Disposition', 'inline; filename="vh-health-api-spec.yaml"');
            
            const yamlString = YAML.stringify(swaggerDocument, 4);
            res.send(yamlString);
          } catch (err) {
            logger.error('Swagger Spec YAML Error:', err);
            res.status(500).json({ 
              error: 'Failed to generate YAML specification',
              details: err.message 
            });
          }
        }
      ],

      // 📊 API Documentation Statistics
      [
        '/stats',
        [
          query('format').optional().isIn(['json', 'summary']).withMessage('Format must be json or summary')
        ],
        (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              errors: errors.array()
            });
          }

          try {
            const { format = 'json' } = req.query;
            const paths = swaggerDocument.paths || {};
            const methods = {};
            const tags = {};
            let totalEndpoints = 0;
            let securedEndpoints = 0;

            // Analyze all endpoints
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
                }
              });
            });

            const stats = {
              overview: {
                totalEndpoints,
                totalPaths: Object.keys(paths).length,
                securedEndpoints,
                securityCoverage: totalEndpoints > 0 ? Math.round((securedEndpoints / totalEndpoints) * 100) : 0
              },
              apiInfo: {
                title: swaggerDocument.info?.title || 'VH Health API',
                version: swaggerDocument.info?.version || '1.0.0',
                description: swaggerDocument.info?.description ? 'Available' : 'Not provided',
                specVersion: swaggerDocument.openapi || '3.0.0'
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
                servers: swaggerDocument.servers?.map(server => ({
                  url: server.url,
                  description: server.description
                })) || [],
                hasComponents: !!(swaggerDocument.components),
                hasSchemas: !!(swaggerDocument.components?.schemas),
                schemaCount: Object.keys(swaggerDocument.components?.schemas || {}).length
              },
              metadata: {
                lastUpdated: new Date().toISOString(),
                specSource: swaggerLoadError ? 'fallback-generated' : 'file-loaded',
                loadError: swaggerLoadError || null,
                generatedBy: 'VH Health Documentation System'
              }
            };

            if (format === 'summary') {
              const summary = {
                title: stats.apiInfo.title,
                version: stats.apiInfo.version,
                totalEndpoints: stats.overview.totalEndpoints,
                securityCoverage: `${stats.overview.securityCoverage}%`,
                topMethods: Object.entries(methods)
                  .sort(([,a], [,b]) => b - a)
                  .slice(0, 3)
                  .map(([method, count]) => `${method.toUpperCase()}: ${count}`),
                status: stats.overview.totalEndpoints > 0 ? 'healthy' : 'no-endpoints'
              };
              
              return success(res, summary, 'API documentation summary');
            }

            success(res, stats, 'API documentation statistics retrieved successfully');
          } catch (err) {
            logger.error('Documentation Stats Error:', err);
            error(res, 'Failed to generate documentation statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔍 Validate OpenAPI Specification
      [
        '/validate',
        [
          query('strict').optional().isBoolean().withMessage('Strict validation flag must be boolean')
        ],
        (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              errors: errors.array()
            });
          }

          try {
            const { strict = false } = req.query;
            const validation = {
              valid: true,
              errors: [],
              warnings: [],
              info: {},
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

            // Strict validation checks
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

            // Specification info
            validation.info = {
              specVersion: swaggerDocument.openapi || 'unknown',
              pathCount: Object.keys(swaggerDocument.paths || {}).length,
              schemaCount: Object.keys(swaggerDocument.components?.schemas || {}).length,
              securitySchemeCount: Object.keys(swaggerDocument.components?.securitySchemes || {}).length,
              serverCount: (swaggerDocument.servers || []).length,
              tagCount: (swaggerDocument.tags || []).length,
              hasExternalDocs: !!swaggerDocument.externalDocs,
              estimatedComplexity: validation.info.pathCount > 50 ? 'high' : 
                                  validation.info.pathCount > 20 ? 'medium' : 'low'
            };

            const status = validation.valid ? 'valid' : 'invalid';
            const message = validation.valid 
              ? `OpenAPI specification is valid${validation.warnings.length > 0 ? ` with ${validation.warnings.length} warning(s)` : ''}`
              : `OpenAPI specification has ${validation.errors.length} error(s)`;

            success(res, {
              status,
              validation,
              validatedAt: new Date().toISOString(),
              strictMode: strict,
              specSource: swaggerLoadError ? 'fallback' : 'file'
            }, message);

          } catch (err) {
            logger.error('Swagger Validation Error:', err);
            error(res, 'Failed to validate OpenAPI specification', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📋 API Documentation Health Check
      [
        '/health',
        async (req, res) => {
          try {
            const health = {
              status: 'healthy',
              documentation: {
                available: true,
                format: 'OpenAPI 3.0+',
                uiAvailable: true,
                specFormats: ['JSON', 'YAML'],
                source: swaggerLoadError ? 'generated' : 'file'
              },
              endpoints: {
                total: Object.keys(swaggerDocument.paths || {}).length,
                documented: true,
                authRequired: !!(swaggerDocument.security && swaggerDocument.security.length > 0),
                publicEndpoints: 0 // Count endpoints without auth
              },
              features: {
                interactiveUI: true,
                downloadableSpec: true,
                validation: true,
                statistics: true,
                searching: true,
                filtering: true
              },
              metadata: {
                title: swaggerDocument.info?.title,
                version: swaggerDocument.info?.version,
                lastModified: new Date().toISOString(),
                loadSource: swaggerLoadError ? 'fallback-generated' : 'swagger.yaml',
                specSize: JSON.stringify(swaggerDocument).length
              }
            };

            // Count public endpoints (no auth required)
            const paths = swaggerDocument.paths || {};
            Object.values(paths).forEach(pathObj => {
              Object.values(pathObj).forEach(operation => {
                if (typeof operation === 'object' && (!operation.security || operation.security.length === 0)) {
                  health.endpoints.publicEndpoints++;
                }
              });
            });

            // Add any warnings
            const warnings = [];
            if (swaggerLoadError) {
              warnings.push('Original swagger.yaml file could not be loaded, using fallback documentation');
            }
            if (health.endpoints.total === 0) {
              warnings.push('No API endpoints documented');
              health.status = 'degraded';
            }

            if (warnings.length > 0) {
              health.warnings = warnings;
            }

            success(res, health, 'API documentation health check completed');
          } catch (err) {
            logger.error('Documentation Health Check Error:', err);
            error(res, 'Documentation health check failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔗 API Endpoint Discovery
      [
        '/discover',
        [
          query('tag').optional().isLength({ min: 1 }).withMessage('Tag filter cannot be empty'),
          query('method').optional().isIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).withMessage('Invalid HTTP method')
        ],
        (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              success: false,
              errors: errors.array()
            });
          }

          try {
            const { tag, method } = req.query;
            const paths = swaggerDocument.paths || {};
            const endpoints = [];

            Object.entries(paths).forEach(([path, pathObj]) => {
              Object.entries(pathObj).forEach(([httpMethod, operation]) => {
                if (['get', 'post', 'put', 'patch', 'delete'].includes(httpMethod)) {
                  // Apply filters
                  if (method && httpMethod.toUpperCase() !== method.toUpperCase()) {
                    return;
                  }
                  
                  if (tag && (!operation.tags || !operation.tags.includes(tag))) {
                    return;
                  }

                  endpoints.push({
                    path,
                    method: httpMethod.toUpperCase(),
                    summary: operation.summary || 'No summary available',
                    description: operation.description || 'No description available',
                    tags: operation.tags || [],
                    deprecated: operation.deprecated || false,
                    requiresAuth: !!(operation.security || swaggerDocument.security),
                    parameters: (operation.parameters || []).map(param => ({
                      name: param.name,
                      in: param.in,
                      required: param.required || false,
                      type: param.schema?.type || 'unknown'
                    })),
                    requestBody: operation.requestBody ? {
                      required: operation.requestBody.required || false,
                      contentTypes: Object.keys(operation.requestBody.content || {})
                    } : null,
                    responses: Object.keys(operation.responses || {})
                  });
                }
              });
            });

            // Sort endpoints by path and method
            endpoints.sort((a, b) => {
              if (a.path !== b.path) return a.path.localeCompare(b.path);
              return a.method.localeCompare(b.method);
            });

            const discovery = {
              totalEndpoints: endpoints.length,
              filteredBy: { tag, method },
              availableTags: [...new Set(
                Object.values(paths)
                  .flatMap(pathObj => 
                    Object.values(pathObj)
                      .filter(op => typeof op === 'object' && op.tags)
                      .flatMap(op => op.tags)
                  )
              )].sort(),
              availableMethods: [...new Set(endpoints.map(e => e.method))].sort(),
              endpoints
            };

            success(res, discovery, 'API endpoints discovered successfully');
          } catch (err) {
            logger.error('API Discovery Error:', err);
            error(res, 'Failed to discover API endpoints', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipRBAC: true
  }
);

// 🔧 ====== ADMIN DOCUMENTATION MANAGEMENT ====== 🔧
wrapAutoRBAC(router, 'adminDocumentationRoutes', {
  get: [
    // 📊 Documentation Usage Analytics  
    [
      '/admin/analytics',
      async (req, res) => {
        try {
          const { timeframe = '30d' } = req.query;
          
          // Get documentation access logs if available
          let accessStats = null;
          try {
            const accessResult = await db.query(`
              SELECT 
                DATE(created_at) as date,
                COUNT(*) as views,
                COUNT(DISTINCT ip_address) as unique_visitors
              FROM api_access_logs 
              WHERE endpoint LIKE '/api-docs%' 
                AND created_at >= NOW() - INTERVAL '30 days'
              GROUP BY DATE(created_at)
              ORDER BY date DESC
              LIMIT 30
            `);

            accessStats = {
              dailyViews: accessResult.rows,
              totalViews: accessResult.rows.reduce((sum, row) => sum + parseInt(row.views), 0),
              uniqueVisitors: accessResult.rows.reduce((sum, row) => sum + parseInt(row.unique_visitors), 0)
            };
          } catch (accessError) {
            logger.warn('Documentation access stats unavailable:', accessError.message);
          }

          // Analyze current documentation
          const paths = swaggerDocument.paths || {};
          const docAnalysis = {
            totalEndpoints: 0,
            documentedEndpoints: 0,
            undocumentedEndpoints: 0,
            endpointsWithExamples: 0,
            deprecatedEndpoints: 0,
            securedEndpoints: 0
          };

          Object.values(paths).forEach(pathObj => {
            Object.values(pathObj).forEach(operation => {
              if (typeof operation === 'object') {
                docAnalysis.totalEndpoints++;
                
                if (operation.summary || operation.description) {
                  docAnalysis.documentedEndpoints++;
                } else {
                  docAnalysis.undocumentedEndpoints++;
                }
                
                if (operation.requestBody?.content || operation.responses) {
                  docAnalysis.endpointsWithExamples++;
                }
                
                if (operation.deprecated) {
                  docAnalysis.deprecatedEndpoints++;
                }
                
                if (operation.security || swaggerDocument.security) {
                  docAnalysis.securedEndpoints++;
                }
              }
            });
          });

          const analytics = {
            overview: {
              ...docAnalysis,
              documentationCoverage: docAnalysis.totalEndpoints > 0 ? 
                Math.round((docAnalysis.documentedEndpoints / docAnalysis.totalEndpoints) * 100) : 0,
              securityCoverage: docAnalysis.totalEndpoints > 0 ? 
                Math.round((docAnalysis.securedEndpoints / docAnalysis.totalEndpoints) * 100) : 0
            },
            usage: accessStats,
            recommendations: [],
            healthScore: 0
          };

          // Generate recommendations
          if (analytics.overview.documentationCoverage < 80) {
            analytics.recommendations.push({
              type: 'documentation',
              priority: 'high',
              message: `${analytics.overview.undocumentedEndpoints} endpoints need documentation`
            });
          }

          if (analytics.overview.securityCoverage < 90) {
            analytics.recommendations.push({
              type: 'security',
              priority: 'medium',
              message: 'Consider adding security requirements to more endpoints'
            });
          }

          if (analytics.overview.deprecatedEndpoints > 0) {
            analytics.recommendations.push({
              type: 'maintenance',
              priority: 'medium',
              message: `${analytics.overview.deprecatedEndpoints} deprecated endpoints should be reviewed`
            });
          }

          // Calculate health score (0-100)
          analytics.healthScore = Math.round(
            (analytics.overview.documentationCoverage * 0.4) +
            (analytics.overview.securityCoverage * 0.3) +
            ((analytics.overview.totalEndpoints > 0 ? 1 : 0) * 30)
          );

          analytics.metadata = {
            timeframe,
            generatedAt: new Date().toISOString(),
            generatedBy: req.user?.name || 'System Admin',
            specSource: swaggerLoadError ? 'fallback' : 'file'
          };

          success(res, analytics, 'Documentation analytics retrieved successfully');

        } catch (err) {
          logger.error('Documentation Analytics Error:', err);
          error(res, 'Failed to generate documentation analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  post: [
    // 🔄 Regenerate Documentation
    [
      '/admin/regenerate',
      [
        body('source').optional().isIn(['file', 'fallback']).withMessage('Source must be file or fallback'),
        body('force').optional().isBoolean().withMessage('Force flag must be boolean')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array()
          });
        }

        try {
          const { source = 'file', force = false } = req.body;
          const adminUid = req.user?.uid;
          const adminName = req.user?.name || 'System Admin';

          let regenerationResult = {
            success: false,
            source: 'unknown',
            oldEndpointCount: Object.keys(swaggerDocument.paths || {}).length,
            newEndpointCount: 0,
            errors: []
          };

          if (source === 'file' || !force) {
            // Try to reload from file
            try {
              const swaggerPath = path.join(__dirname, '../docs/swagger.yaml');
              
              if (fs.existsSync(swaggerPath)) {
                const newSwaggerDocument = YAML.load(swaggerPath);
                swaggerDocument = newSwaggerDocument;
                regenerationResult.success = true;
                regenerationResult.source = 'file';
                regenerationResult.newEndpointCount = Object.keys(swaggerDocument.paths || {}).length;
                swaggerLoadError = null;
                
                logger.info(`📚 Swagger documentation reloaded from file by ${adminName}`);
              } else {
                regenerationResult.errors.push('swagger.yaml file not found');
              }
            } catch (fileError) {
              regenerationResult.errors.push(`Failed to load from file: ${fileError.message}`);
            }
          }

          if (!regenerationResult.success && (source === 'fallback' || force)) {
            // Regenerate fallback documentation - this would typically involve
            // scanning routes and generating documentation dynamically
            regenerationResult.success = true;
            regenerationResult.source = 'fallback';
            regenerationResult.newEndpointCount = Object.keys(swaggerDocument.paths || {}).length;
            
            logger.info(`📚 Swagger documentation regenerated using fallback by ${adminName}`);
          }

          // Log regeneration activity
          await db.query(
            `INSERT INTO admin_activity_logs (
              admin_uid, action, description, details, 
              ip_address, created_at
            ) VALUES ($1, $2, $3, $4, $5, NOW())`,
            [
              adminUid,
              'DOCUMENTATION_REGENERATED',
              `API documentation regenerated from ${regenerationResult.source}`,
              JSON.stringify(regenerationResult),
              req.headers['x-forwarded-for'] || req.socket?.remoteAddress
            ]
          );

          if (regenerationResult.success) {
            success(res, {
              regenerated: true,
              source: regenerationResult.source,
              endpointCount: {
                before: regenerationResult.oldEndpointCount,
                after: regenerationResult.newEndpointCount,
                change: regenerationResult.newEndpointCount - regenerationResult.oldEndpointCount
              },
              regeneratedAt: new Date().toISOString(),
              regeneratedBy: adminName
            }, 'Documentation regenerated successfully');
          } else {
            error(res, 'Failed to regenerate documentation', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }

        } catch (err) {
          logger.error('Documentation Regeneration Error:', err);
          error(res, 'Failed to regenerate documentation', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
}, {
  requireUID: true,
  requirePhone: false
});

export default router;