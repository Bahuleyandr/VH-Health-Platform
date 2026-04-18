import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../logging/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const backendRoot = path.resolve(__dirname, '..', '..');
const swaggerPath = 'src/docs/swagger.yaml';
const spectralCliPath = path.join(
  backendRoot,
  'node_modules',
  '@stoplight',
  'spectral-cli',
  'dist',
  'index.js',
);

try {
  logger.info('🔍 Validating Swagger file using Spectral...');
  execFileSync(process.execPath, [spectralCliPath, 'lint', swaggerPath], {
    cwd: backendRoot,
    stdio: 'inherit',
  });
  logger.info('✅ Swagger validation passed.');
  process.exit(0); // ensures success exit
} catch (_err) {
  logger.error('❌ Swagger validation failed.');
  process.exit(1); // triggers 500 if run via execSync in API
}
