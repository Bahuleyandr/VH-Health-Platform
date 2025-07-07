// src/scripts/generate-complete-swagger.js
import fs from 'fs';
import path from 'path';
import YAML from 'yamljs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use the clean file
const discoveredRoutesPath = path.join(__dirname, '../../all-514-routes-clean.json');

if (!fs.existsSync(discoveredRoutesPath)) {
  console.error('❌ all-514-routes-clean.json not found in project root.');
  console.error('\nTo create it, run this PowerShell command:');
  console.error('Get-Content "all-514-routes.json" -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 10 | Set-Content -Path "all-514-routes-clean.json" -Encoding UTF8\n');
  process.exit(1);
}

console.log('📚 Generating complete Swagger documentation from discovered routes...\n');

// Load discovered routes
const routeData = JSON.parse(fs.readFileSync(discoveredRoutesPath, 'utf8'));
console.log(`✅ Loaded ${routeData.routes.length} routes from discovery\n`);

// Base swagger structure
const swagger = {
  openapi: '3.0.3',
  info: {
    title: 'VH Health API',
    version: '2.0.0',
    description: `# VH Health - Comprehensive Healthcare Management System

Complete API documentation for VH Health's ${routeData.routes.length} endpoints across ${Object.keys(routeData.metadata).length} services.

## Services Available:
${Object.entries(routeData.metadata).map(([name, meta]) => 
  `- **${name}** (${meta.endpoints} endpoints): ${meta.description}`
).join('\n')}

## Authentication
- API Key required in header: \`x-api-key\`
- JWT Bearer token for user authentication
- Role-based access control (RBAC) with 23-tier hierarchy

## Base URLs
- Production: \`https://vh-health-backend.onrender.com/api/v1\`
- Development: \`http://localhost:5000/api/v1\`
`,
    contact: {
      name: 'VH Health Tech Team',
      email: 'api@vhhealth.com',
      url: 'https://vhhealth.com'
    },
    license: {
      name: 'Proprietary',
      url: 'https://vhhealth.com/license'
    }
  },
  servers: [
    {
      url: 'https://vh-health-backend.onrender.com/api/v1',
      description: 'Production server'
    },
    {
      url: 'http://localhost:5000/api/v1',
      description: 'Development server'
    }
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'API key for authentication (use: vhhealth123 for development)'
      },
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT token for user authentication'
      }
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string', example: 'Error message' },
          error: { type: 'string', example: 'Error details' },
          details: { type: 'object' }
        }
      },
      Success: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Operation successful' },
          data: { 
            type: 'object',
            description: 'Response data (varies by endpoint)'
          }
        }
      },
      PaginatedResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string' },
          data: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: 'object' } },
              pagination: {
                type: 'object',
                properties: {
                  page: { type: 'integer', example: 1 },
                  limit: { type: 'integer', example: 10 },
                  total: { type: 'integer', example: 100 },
                  totalPages: { type: 'integer', example: 10 }
                }
              }
            }
          }
        }
      }
    },
    responses: {
      UnauthorizedError: {
        description: 'Authentication required',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            example: {
              success: false,
              message: 'Authentication required',
              error: 'No valid API key provided'
            }
          }
        }
      },
      ForbiddenError: {
        description: 'Insufficient permissions',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            example: {
              success: false,
              message: 'Access denied',
              error: 'Insufficient role permissions'
            }
          }
        }
      },
      NotFoundError: {
        description: 'Resource not found',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            example: {
              success: false,
              message: 'Resource not found',
              error: 'The requested resource does not exist'
            }
          }
        }
      },
      ValidationError: {
        description: 'Validation failed',
        content: {
          'application/json': {
            schema: { 
              allOf: [
                { $ref: '#/components/schemas/Error' },
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
    { ApiKeyAuth: [] }
  ],
  tags: [],
  paths: {}
};

// Create tags from metadata
Object.entries(routeData.metadata).sort().forEach(([service, meta]) => {
  swagger.tags.push({
    name: service,
    description: `${meta.description} (${meta.endpoints} endpoints, ${meta.security})`,
    externalDocs: {
      description: `${service} documentation`,
      url: `https://docs.vhhealth.com/${service}`
    }
  });
});

// Helper functions
function generateSummary(route) {
  const pathParts = route.path.split('/').filter(p => p && !p.startsWith(':'));
  const lastPart = pathParts[pathParts.length - 1];
  const service = route.service;
  
  // Special cases
  if (route.path.endsWith('/:id')) {
    const action = route.method === 'GET' ? 'Get' : 
                   route.method === 'PUT' ? 'Update' :
                   route.method === 'DELETE' ? 'Delete' : route.method;
    return `${action} ${service} by ID`;
  }
  
  if (lastPart === service || !lastPart) {
    const action = route.method === 'GET' ? 'List' : 
                   route.method === 'POST' ? 'Create' : route.method;
    return `${action} ${service}`;
  }
  
  // Format the last part
  const formatted = lastPart
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  
  return `${route.method === 'GET' ? '' : route.method + ' '}${formatted}`;
}

function generateOperationId(route) {
  const pathParts = route.path
    .split('/')
    .filter(p => p && !p.startsWith(':') && p !== 'api' && p !== 'v1');
  
  const method = route.method.toLowerCase();
  const parts = [method, ...pathParts];
  
  return parts
    .map((part, index) => {
      if (index === 0) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('')
    .replace(/-/g, '');
}

function extractParameters(path) {
  const params = [];
  const pathParts = path.split('/');
  
  // Extract path parameters
  pathParts.forEach(part => {
    if (part.startsWith(':')) {
      const paramName = part.substring(1);
      params.push({
        name: paramName,
        in: 'path',
        required: true,
        description: `${paramName === 'id' ? 'Resource identifier' : paramName.charAt(0).toUpperCase() + paramName.slice(1)}`,
        schema: {
          type: 'string',
          example: paramName === 'id' ? '123e4567-e89b-12d3-a456-426614174000' : `example-${paramName}`
        }
      });
    }
  });
  
  return params;
}

function generateResponses(route) {
  const responses = {};
  
  // Success responses
  if (route.method === 'GET') {
    responses['200'] = {
      description: 'Successful retrieval',
      content: {
        'application/json': {
          schema: route.path.includes(':id') ? 
            { $ref: '#/components/schemas/Success' } :
            { $ref: '#/components/schemas/PaginatedResponse' }
        }
      }
    };
  } else if (route.method === 'POST') {
    responses['201'] = {
      description: 'Resource created successfully',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Success' }
        }
      }
    };
  } else if (route.method === 'PUT' || route.method === 'PATCH') {
    responses['200'] = {
      description: 'Resource updated successfully',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Success' }
        }
      }
    };
  } else if (route.method === 'DELETE') {
    responses['204'] = {
      description: 'Resource deleted successfully'
    };
  }
  
  // Error responses
  responses['400'] = { $ref: '#/components/responses/ValidationError' };
  responses['401'] = { $ref: '#/components/responses/UnauthorizedError' };
  
  // Role-specific endpoints need 403
  if (route.security && !route.security.includes('public')) {
    responses['403'] = { $ref: '#/components/responses/ForbiddenError' };
  }
  
  // Endpoints with :id need 404
  if (route.path.includes(':id')) {
    responses['404'] = { $ref: '#/components/responses/NotFoundError' };
  }
  
  responses['500'] = {
    description: 'Internal server error',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' }
      }
    }
  };
  
  return responses;
}

// Generate paths
const pathsMap = {};

routeData.routes.forEach(route => {
  const path = route.path;
  
  if (!pathsMap[path]) {
    pathsMap[path] = {};
  }
  
  const operation = {
    tags: [route.service],
    summary: generateSummary(route),
    description: `${route.method} endpoint for ${route.service} service. Security: ${route.security}`,
    operationId: generateOperationId(route),
    parameters: extractParameters(path),
    responses: generateResponses(route),
    security: route.security.includes('public') ? [] : [{ ApiKeyAuth: [] }, { BearerAuth: [] }]
  };
  
  // Add common query parameters for list endpoints
  if (route.method === 'GET' && !path.includes(':') && path !== '/api/v1/health') {
    operation.parameters.push(
      {
        name: 'page',
        in: 'query',
        description: 'Page number',
        schema: { type: 'integer', minimum: 1, default: 1 }
      },
      {
        name: 'limit',
        in: 'query',
        description: 'Items per page',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 }
      },
      {
        name: 'search',
        in: 'query',
        description: 'Search query',
        schema: { type: 'string' }
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort field',
        schema: { type: 'string' }
      },
      {
        name: 'order',
        in: 'query',
        description: 'Sort order',
        schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' }
      }
    );
  }
  
  // Add request body for POST/PUT
  if (['POST', 'PUT', 'PATCH'].includes(route.method)) {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            description: `Request body for ${route.service}`
          }
        }
      }
    };
  }
  
  pathsMap[path][route.method.toLowerCase()] = operation;
});

// Sort paths
const sortedPaths = {};
Object.keys(pathsMap).sort().forEach(key => {
  sortedPaths[key] = pathsMap[key];
});
swagger.paths = sortedPaths;

// Save output
const outputDir = path.join(__dirname, '../docs');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Save as YAML
const yamlPath = path.join(outputDir, 'swagger-complete.yaml');
const yamlStr = YAML.stringify(swagger, 10, 2);
fs.writeFileSync(yamlPath, yamlStr);

// Save as JSON
const jsonPath = path.join(outputDir, 'swagger-complete.json');
fs.writeFileSync(jsonPath, JSON.stringify(swagger, null, 2));

// Print summary
console.log('✅ Generation complete!\n');
console.log(`📁 Files created:`);
console.log(`   - ${yamlPath}`);
console.log(`   - ${jsonPath}`);
console.log(`\n📊 Summary:`);
console.log(`   - Total paths: ${Object.keys(swagger.paths).length}`);
console.log(`   - Total operations: ${routeData.routes.length}`);
console.log(`   - Services/Tags: ${swagger.tags.length}`);
console.log(`\n📋 Services included:`);
swagger.tags.forEach(tag => {
  console.log(`   - ${tag.name}: ${tag.description}`);
});
console.log('\n💡 Next steps:');
console.log('   1. Review: src/docs/swagger-complete.yaml');
console.log('   2. If satisfied, replace: cp src/docs/swagger-complete.yaml src/docs/swagger.yaml');
console.log('   3. Convert to JSON: npm run swagger:generate');
console.log('   4. Validate: npm run swagger:validate');