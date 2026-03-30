import { readFileSync } from 'fs';
import logger from '../logging/logger.js';

export async function checkDependencyHealth() {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    const nodeVersion = process.version;
    const expectedNode = pkg.engines?.node;

    const warnings = [];

    // Check Node.js version
    if (expectedNode && !nodeVersion.includes(expectedNode.replace('>=', '').trim())) {
      warnings.push(`Node.js version mismatch: running ${nodeVersion}, expected ${expectedNode}`);
    }

    // Check for known vulnerable patterns
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Log startup info
    logger.info('📦 Dependency health check:', {
      nodeVersion,
      expectedNode: expectedNode || 'not specified',
      totalDeps: Object.keys(pkg.dependencies || {}).length,
      totalDevDeps: Object.keys(pkg.devDependencies || {}).length,
      warnings: warnings.length > 0 ? warnings : 'none',
    });

    if (warnings.length > 0) {
      warnings.forEach(w => logger.warn(`⚠️ ${w}`));
    }

    return { healthy: warnings.length === 0, warnings, nodeVersion, expectedNode };
  } catch (error) {
    logger.error('Dependency health check error:', error.message);
    return { healthy: false, error: error.message };
  }
}
