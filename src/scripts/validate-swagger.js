// src/scripts/validate-swagger.js

const { execSync } = require('child_process');
const path = require('path');

const swaggerFilePath = path.join(__dirname, '../utils/swagger.yaml');

console.log('🔍 Validating Swagger file using Spectral...');

try {
  execSync(`npx spectral lint ${swaggerFilePath}`, { stdio: 'inherit' });
  console.log('✅ Swagger validation passed.');
} catch (err) {
  console.error('❌ Swagger validation failed.');
  process.exit(1);
}
