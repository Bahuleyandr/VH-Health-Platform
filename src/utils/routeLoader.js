// src/utils/routeLoader.js
// Dynamic Route Loading Utilities

import logger from '../logging/logger.js';
import { ROUTE_FILES, ROUTE_METADATA, getCurrentEnvironmentConfig } from '../config/routeConfig.js';
import path from 'path';

/**
 * Creates a development stub router for production environments
 */
function createDevelopmentStub() {
  return {
    stack: [],
    __isDevelopmentStub: true,
    use: () => {},
    get: () => {},
    post: () => {},
    put: () => {},
    delete: () => {},
    patch: () => {}
  };
}

/**
 * Loads a single route module
 */
async function loadRouteModule(routeName, filePath, metadata) {
  try {
    if (metadata.developmentOnly && !getCurrentEnvironmentConfig().enableDevRoutes) {
      logger.info(`ℹ️ ${routeName} skipped (production mode)`);
      return createDevelopmentStub();
    }

    // Normalize paths for modular structure
    const modularPath = filePath.replace(/Routes\.js$/, '/index.js');

    const module = await import(modularPath);
    const routeModule = module.default;

    if (!routeModule) {
      throw new Error(`Route module ${routeName} does not export a default`);
    }

    logger.info(`✅ ${routeName} loaded successfully${metadata.developmentOnly ? ' (development mode)' : ''}`);
    return routeModule;
  } catch (err) {
    const errorMessage = `${routeName} failed to load: ${err.message}`;

    if (metadata.developmentOnly && !getCurrentEnvironmentConfig().enableDevRoutes) {
      logger.info(`ℹ️ ${routeName} skipped in production (dev only)`);
      return createDevelopmentStub();
    }

    if (metadata.priority === 'critical') {
      logger.error(`❌ ${errorMessage}`);
      throw new Error(errorMessage);
    }

    logger.error(`❌ ${errorMessage}`);
    return createDevelopmentStub();
  }
}

export async function loadRoutesByCategory(category) {
  const routes = {};
  const categoryRoutes = Object.entries(ROUTE_METADATA)
    .filter(([, metadata]) => metadata.category === category);

  logger.info(`📁 Loading ${category} routes...`);

  for (const [routeName, metadata] of categoryRoutes) {
    const filePath = ROUTE_FILES[routeName];
    if (!filePath) {
      logger.warn(`⚠️ No file path defined for route: ${routeName}`);
      continue;
    }

    routes[routeName] = await loadRouteModule(routeName, filePath, metadata);
  }

  logger.info(`✅ ${category} routes loaded successfully`);
  return routes;
}

export async function loadAllRoutes() {
  const allRoutes = {};
  const categories = [...new Set(Object.values(ROUTE_METADATA).map(meta => meta.category))];

  logger.info('🚀 Starting route loading process...');

  for (const category of categories) {
    try {
      const categoryRoutes = await loadRoutesByCategory(category);
      Object.assign(allRoutes, categoryRoutes);
    } catch (err) {
      logger.error(`❌ Failed to load ${category} routes:`, err.message);

      const criticalRoutes = Object.entries(ROUTE_METADATA)
        .filter(([, metadata]) => metadata.category === category && metadata.priority === 'critical')
        .map(([routeName]) => routeName);

      if (criticalRoutes.length > 0) {
        throw new Error(`Critical ${category} routes failed to load: ${criticalRoutes.join(', ')}`);
      }
    }
  }

  return allRoutes;
}

export async function loadRoutesByPriority() {
  const allRoutes = {};
  const routeEntries = Object.entries(ROUTE_METADATA);
  const priorityOrder = { critical: 1, high: 2, medium: 3, low: 4 };
  routeEntries.sort(([, a], [, b]) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  logger.info('🎯 Loading routes by priority...');

  for (const [routeName, metadata] of routeEntries) {
    const filePath = ROUTE_FILES[routeName];
    if (!filePath) {
      logger.warn(`⚠️ No file path defined for route: ${routeName}`);
      continue;
    }

    try {
      allRoutes[routeName] = await loadRouteModule(routeName, filePath, metadata);
    } catch (err) {
      if (metadata.priority === 'critical') {
        logger.error(`❌ Critical route ${routeName} failed to load. Stopping process.`);
        throw err;
      }

      logger.warn(`⚠️ Non-critical route ${routeName} failed, using stub`);
      allRoutes[routeName] = createDevelopmentStub();
    }
  }

  return allRoutes;
}

export function validateLoadedRoutes(routes) {
  const validation = {
    totalRoutes: Object.keys(routes).length,
    validRoutes: 0,
    stubRoutes: 0,
    missingRoutes: [],
    invalidRoutes: [],
    developmentStubs: 0
  };

  for (const routeName of Object.keys(ROUTE_METADATA)) {
    if (!routes[routeName]) {
      validation.missingRoutes.push(routeName);
    } else {
      const route = routes[routeName];

      if (route.__isDevelopmentStub) {
        validation.stubRoutes++;
        validation.developmentStubs++;
      } else if (typeof route === 'object' && (route.stack || typeof route.use === 'function')) {
        validation.validRoutes++;
      } else {
        validation.invalidRoutes.push(routeName);
      }
    }
  }

  const healthyRoutes = validation.validRoutes + validation.stubRoutes;
  validation.healthPercentage = Math.round((healthyRoutes / validation.totalRoutes) * 100);

  return validation;
}

export async function reloadRoute(routeName) {
  const metadata = ROUTE_METADATA[routeName];
  const filePath = ROUTE_FILES[routeName];

  if (!metadata || !filePath) {
    throw new Error(`Route ${routeName} not found in configuration`);
  }

  logger.info(`🔄 Reloading route: ${routeName}`);

  return await loadRouteModule(routeName, filePath, metadata);
}

export function getRouteLoadingStats(routes) {
  const stats = {
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    totalRoutes: Object.keys(routes).length,
    byCategory: {},
    byPriority: {},
    byStatus: {
      loaded: 0,
      stubbed: 0,
      failed: 0
    }
  };

  for (const [routeName, route] of Object.entries(routes)) {
    const metadata = ROUTE_METADATA[routeName];
    if (!metadata) continue;

    stats.byCategory[metadata.category] = (stats.byCategory[metadata.category] || 0) + 1;
    stats.byPriority[metadata.priority] = (stats.byPriority[metadata.priority] || 0) + 1;

    if (route.__isDevelopmentStub) {
      stats.byStatus.stubbed++;
    } else if (typeof route === 'object' && (route.stack || typeof route.use === 'function')) {
      stats.byStatus.loaded++;
    } else {
      stats.byStatus.failed++;
    }
  }

  return stats;
}
