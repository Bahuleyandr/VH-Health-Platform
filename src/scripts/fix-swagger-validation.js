// fix-swagger-validation.js
// Script to fix common Swagger/OpenAPI validation errors

import fs from 'fs';
import path from 'path';
import YAML from 'yamljs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the swagger file
const swaggerPath = path.join(__dirname, '../src/docs/swagger.yaml');
const swagger = YAML.load(swaggerPath);

console.log('🔧 Fixing Swagger validation errors...\n');

let fixCount = 0;
const operationIdMap = new Map();

// Helper to generate unique operationId
function generateOperationId(path, method, tag) {
  const parts = path.split('/').filter(p => p && !p.startsWith(':') && !p.startsWith('{'));
  const resource = parts[parts.length - 1] || parts[parts.length - 2] || 'resource';
  
  // Extract action from path if present
  const actions = ['cancel', 'complete', 'confirm', 'approve', 'reject', 'archive', 'restore', 
                   'download', 'upload', 'share', 'verify', 'activate', 'deactivate'];
  const action = parts.find(p => actions.includes(p));
  
  // Build operationId
  let baseId = method;
  if (action) baseId += capitalize(action);
  baseId += capitalize(resource);
  
  // Handle path parameters
  if (path.includes(':') || path.includes('{')) {
    const params = (path.match(/:[a-zA-Z]+|{[a-zA-Z]+}/g) || [])
      .map(p => p.replace(/[:{}]/g, ''));
    if (params.length > 0) {
      baseId += 'By' + params.map(capitalize).join('And');
    }
  }
  
  // Ensure uniqueness
  let finalId = baseId;
  let counter = 1;
  while (operationIdMap.has(finalId)) {
    finalId = `${baseId}${counter}`;
    counter++;
  }
  operationIdMap.set(finalId, true);
  
  return finalId;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Fix 1: Convert Express-style parameters to OpenAPI style
Object.keys(swagger.paths).forEach(path => {
  if (path.includes(':')) {
    const newPath = path.replace(/:([a-zA-Z]+)/g, '{$1}');
    swagger.paths[newPath] = swagger.paths[path];
    delete swagger.paths[path];
    
    console.log(`✅ Fixed path: ${path} → ${newPath}`);
    fixCount++;
    
    // Update parameter definitions to match
    Object.keys(swagger.paths[newPath]).forEach(method => {
      const operation = swagger.paths[newPath][method];
      if (operation.parameters) {
        operation.parameters.forEach(param => {
          if (param.in === 'path') {
            // Extract parameter name from the path
            const pathParams = (newPath.match(/{([a-zA-Z]+)}/g) || [])
              .map(p => p.replace(/[{}]/g, ''));
            
            // Ensure parameter name matches what's in the path
            if (!pathParams.includes(param.name)) {
              const oldName = param.name;
              param.name = pathParams.find(p => p.toLowerCase() === oldName.toLowerCase()) || pathParams[0];
              console.log(`  ✅ Fixed parameter name: ${oldName} → ${param.name}`);
              fixCount++;
            }
          }
        });
      }
    });
  }
});

// Fix 2: Generate unique operationIds
Object.entries(swagger.paths).forEach(([path, pathItem]) => {
  Object.entries(pathItem).forEach(([method, operation]) => {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
      const tag = operation.tags?.[0] || 'default';
      const newOperationId = generateOperationId(path, method, tag);
      
      if (operation.operationId !== newOperationId) {
        console.log(`✅ Fixed operationId: ${operation.operationId || 'none'} → ${newOperationId}`);
        operation.operationId = newOperationId;
        fixCount++;
      }
    }
  });
});

// Fix 3: Ensure all path parameters are properly defined
Object.entries(swagger.paths).forEach(([path, pathItem]) => {
  // Extract parameters from path
  const pathParams = (path.match(/{([a-zA-Z]+)}/g) || [])
    .map(p => p.replace(/[{}]/g, ''));
  
  if (pathParams.length > 0) {
    Object.entries(pathItem).forEach(([method, operation]) => {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        // Initialize parameters array if not exists
        if (!operation.parameters) {
          operation.parameters = [];
        }
        
        // Check each path parameter
        pathParams.forEach(paramName => {
          const existingParam = operation.parameters.find(
            p => p.in === 'path' && p.name === paramName
          );
          
          if (!existingParam) {
            // Add missing parameter
            operation.parameters.push({
              name: paramName,
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: `${capitalize(paramName)} parameter`
            });
            console.log(`✅ Added missing parameter: ${paramName} to ${method.toUpperCase()} ${path}`);
            fixCount++;
          }
        });
        
        // Remove parameters that are not in the path
        operation.parameters = operation.parameters.filter(param => {
          if (param.in === 'path' && !pathParams.includes(param.name)) {
            console.log(`✅ Removed invalid parameter: ${param.name} from ${method.toUpperCase()} ${path}`);
            fixCount++;
            return false;
          }
          return true;
        });
      }
    });
  }
});

// Fix 4: Add missing response definitions
Object.entries(swagger.paths).forEach(([path, pathItem]) => {
  Object.entries(pathItem).forEach(([method, operation]) => {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
      if (!operation.responses) {
        operation.responses = {
          '200': {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApiResponse' }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        };
        console.log(`✅ Added responses to ${method.toUpperCase()} ${path}`);
        fixCount++;
      }
    }
  });
});

// Fix 5: Ensure components.responses exists
if (!swagger.components) {
  swagger.components = {};
}

if (!swagger.components.responses) {
  swagger.components.responses = {
    ValidationError: {
      description: 'Validation error',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' }
        }
      }
    },
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
    InternalError: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' }
        }
      }
    }
  };
  console.log('✅ Added standard response definitions');
  fixCount++;
}

// Save the fixed swagger file
const outputPath = path.join(__dirname, '../src/docs/swagger-fixed.yaml');
const yamlStr = YAML.stringify(swagger, 10);
fs.writeFileSync(outputPath, yamlStr);

console.log(`\n✨ Fixed ${fixCount} issues!`);
console.log(`📄 Fixed swagger saved to: ${outputPath}`);
console.log('\n🔍 Next steps:');
console.log('1. Review the fixed file: swagger-fixed.yaml');
console.log('2. Test it with: npx spectral lint src/docs/swagger-fixed.yaml');
console.log('3. If validation passes, replace the original with: cp src/docs/swagger-fixed.yaml src/docs/swagger.yaml');
console.log('4. Test the UI at: http://localhost:5000/api-docs');