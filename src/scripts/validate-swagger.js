import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../logging/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const swaggerPath = path.join(__dirname, '../docs/swagger.yaml');

try {
  logger.info('🔍 Validating Swagger file using Spectral...');
  execSync(
    `npx spectral lint --ruleset @stoplight/spectral-rulesets/oas ${swaggerPath}`,
    { stdio: 'inherit' },
  );
  logger.info('✅ Swagger validation passed.');
  process.exit(0); // ensures success exit
} catch (err) {
  logger.error('❌ Swagger validation failed.');
  process.exit(1); // triggers 500 if run via execSync in API
}
