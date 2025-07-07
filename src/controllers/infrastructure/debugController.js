// controllers/infrastructure/debugController.js
import { validationResult } from 'express-validator';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { DebugService } from '../../services/infrastructure/debugService.js';
import logger from '../../logging/logger.js';

// Get debug information
export const getDebugInfo = async (req, res) => {
  try {
    const userInfo = {
      uid: req.user?.uid,
      name: req.user?.name,
      role: req.user?.role
    };
    
    const debugInfo = await DebugService.getDebugInfo(userInfo);
    success(res, debugInfo, 'Debug information retrieved');
  } catch (err) {
    logger.error('[GetDebugInfo]:', err);
    error(res, 'Failed to retrieve debug information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Test database connection
export const testDatabase = async (req, res) => {
  try {
    const testResult = await DebugService.testDatabaseConnection();
    testResult.testedBy = req.user?.name;
    
    success(res, testResult, 'Database connection test successful');
  } catch (err) {
    logger.error('[TestDatabase]:', err);
    error(res, {
      connected: false,
      error: err.message,
      testedBy: req.user?.name
    }, 'Database connection failed');
  }
};

// Get application health
export const getHealth = async (req, res) => {
  try {
    const healthData = await DebugService.getApplicationHealth();
    healthData.checkedBy = req.user?.name;
    
    success(res, healthData, `Application health: ${healthData.status}`);
  } catch (err) {
    logger.error('[GetHealth]:', err);
    error(res, {
      status: 'unhealthy',
      error: err.message,
      checkedBy: req.user?.name
    }, 'Health check failed');
  }
};

// Get environment variables
export const getEnvironment = async (req, res) => {
  try {
    const envData = DebugService.getEnvironmentVariables();
    
    success(res, {
      ...envData,
      requestedBy: req.user?.name
    }, 'Environment variables retrieved (sanitized)');
  } catch (err) {
    logger.error('[GetEnvironment]:', err);
    error(res, 'Failed to retrieve environment variables', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get recent logs
export const getLogs = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const { level = 'all', limit = 50 } = req.query;
    
    const logsData = await DebugService.getRecentLogs(level, limit);
    
    success(res, {
      ...logsData,
      requestedBy: req.user?.name
    }, 'Recent logs retrieved');
  } catch (err) {
    logger.error('[GetLogs]:', err);
    error(res, 'Failed to retrieve logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get request headers
export const getHeaders = async (req, res) => {
  try {
    const debugHeaders = {
      allHeaders: req.headers,
      userAgent: req.get('User-Agent'),
      authorization: req.get('Authorization') ? 'Bearer [REDACTED]' : 'None',
      contentType: req.get('Content-Type'),
      acceptLanguage: req.get('Accept-Language'),
      xForwardedFor: req.get('X-Forwarded-For'),
      xRealIp: req.get('X-Real-IP'),
      host: req.get('Host'),
      origin: req.get('Origin'),
      referer: req.get('Referer'),
      userInfo: {
        uid: req.user?.uid,
        role: req.user?.role,
        name: req.user?.name
      },
      requestInfo: {
        method: req.method,
        url: req.url,
        protocol: req.protocol,
        secure: req.secure,
        ip: req.ip,
        ips: req.ips
      }
    };
    
    success(res, debugHeaders, 'Request headers and user info retrieved');
  } catch (err) {
    logger.error('[GetHeaders]:', err);
    error(res, 'Failed to retrieve header information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get performance metrics
export const getPerformance = async (req, res) => {
  try {
    const metrics = await DebugService.getPerformanceMetrics();
    metrics.requestedBy = req.user?.name;
    
    success(res, metrics, 'Performance metrics retrieved');
  } catch (err) {
    logger.error('[GetPerformance]:', err);
    error(res, 'Failed to retrieve performance metrics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Trigger garbage collection
export const triggerGC = async (req, res) => {
  try {
    const gcResult = DebugService.triggerGarbageCollection();
    gcResult.triggeredBy = req.user?.name;
    
    const message = gcResult.triggered 
      ? 'Garbage collection triggered' 
      : 'Garbage collection not available';
      
    success(res, gcResult, message);
  } catch (err) {
    logger.error('[TriggerGC]:', err);
    error(res, 'Failed to trigger garbage collection', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Simulate load test
export const runLoadTest = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const { iterations = 1000, delay = 1 } = req.body;
    
    logger.info(`🔄 Load test started by ${req.user?.name}: ${iterations} iterations`);
    
    const result = await DebugService.simulateLoadTest(iterations, delay);
    result.triggeredBy = req.user?.name;
    
    success(res, result, 'Load test completed');
  } catch (err) {
    logger.error('[RunLoadTest]:', err);
    error(res, 'Load test failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get system information
export const getSystemInfo = async (req, res) => {
  try {
    const systemInfo = await DebugService.getDebugInfo({
      uid: req.user?.uid,
      name: req.user?.name,
      role: req.user?.role
    });
    
    success(res, systemInfo, 'System information retrieved');
  } catch (err) {
    logger.error('[GetSystemInfo]:', err);
    error(res, 'Failed to retrieve system information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Trigger Sentry error for testing
export const triggerSentryError = async (req, res, next) => {
  try {
    logger.warn(`🔥 Sentry debug error triggered by ${req.user?.name || 'Unknown'}`);
    throw new Error(`Sentry debug trigger: Test error for monitoring! Triggered by ${req.user?.name || 'Unknown'}`);
  } catch (err) {
    next(err); // Will be caught by centralized error handler
  }
};

// In debugController.js, replace the getAllRoutes function with this:
export const getAllRoutes = async (req, res) => {
  try {
    const app = req.app;
    const routes = [];
    
    // Debug: Log app structure
    console.log('Debug - App has _router:', !!app._router);
    console.log('Debug - Router stack length:', app._router?.stack?.length || 0);
    
    // Function to extract routes
    function extractRoutes(stack, basePath = '') {
      if (!stack) return;
      
      stack.forEach((layer, index) => {
        console.log(`Debug - Layer ${index}:`, {
          name: layer.name,
          regexp: layer.regexp?.source?.substring(0, 50),
          hasRoute: !!layer.route,
          hasHandle: !!layer.handle
        });
        
        if (layer.route) {
          // This is a route
          Object.keys(layer.route.methods).forEach(method => {
            if (layer.route.methods[method]) {
              routes.push({
                method: method.toUpperCase(),
                path: basePath + layer.route.path,
                middlewareCount: layer.route.stack.length
              });
            }
          });
        } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
          // This is a sub-router
          let mountPath = '';
          if (layer.regexp && layer.regexp.source) {
            // Try to extract mount path
            const source = layer.regexp.source;
            // Match patterns like ^\\/api\\/v1\\/users
            const match = source.match(/\^?\\\/([\w-]+)(?:\\\/([\w-]+))*(?:\\\/([\w-]+))*/);
            if (match) {
              mountPath = '/' + match.slice(1).filter(Boolean).join('/');
            }
          }
          console.log(`Debug - Found sub-router at: ${mountPath}`);
          extractRoutes(layer.handle.stack, basePath + mountPath);
        }
      });
    }
    
    // Extract from main router
    if (app._router && app._router.stack) {
      extractRoutes(app._router.stack);
    }
    
    console.log(`Debug - Total routes found: ${routes.length}`);
    
    // If no routes found, return diagnostic info
    if (routes.length === 0) {
      return res.json({
        success: true,
        data: {
          summary: {
            total: 0,
            message: 'No routes extracted - see console logs'
          },
          diagnostic: {
            hasRouter: !!app._router,
            stackLength: app._router?.stack?.length || 0,
            layers: app._router?.stack?.slice(0, 10).map(layer => ({
              name: layer.name,
              regexp: layer.regexp?.source?.substring(0, 100),
              hasRoute: !!layer.route,
              hasHandle: !!layer.handle,
              handleName: layer.handle?.name
            })) || []
          },
          routes: []
        }
      });
    }
    
    // Remove duplicates and continue with existing logic...
    const uniqueRoutes = [];
    const seen = new Set();
    
    routes.forEach(route => {
      const key = `${route.method} ${route.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueRoutes.push(route);
      }
    });
    
    uniqueRoutes.sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.method.localeCompare(b.method);
    });
    
    // Create summary
    const summary = {
      total: uniqueRoutes.length,
      byMethod: {},
      byCategory: {}
    };
    
    uniqueRoutes.forEach(route => {
      summary.byMethod[route.method] = (summary.byMethod[route.method] || 0) + 1;
      
      const categoryMatch = route.path.match(/^\/api\/v\d+\/([^\/]+)/);
      if (categoryMatch) {
        const category = categoryMatch[1];
        summary.byCategory[category] = (summary.byCategory[category] || 0) + 1;
      }
    });
    
    // Return based on format
    const format = req.query.format || 'json';
    
    if (format === 'csv') {
      const csv = [
        'Method,Path',
        ...uniqueRoutes.map(r => `${r.method},${r.path}`)
      ].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="routes.csv"');
      res.send(csv);
    } else if (format === 'text') {
      const text = uniqueRoutes.map(r => `${r.method} ${r.path}`).join('\n');
      res.setHeader('Content-Type', 'text/plain');
      res.send(text);
    } else {
      res.json({
        success: true,
        data: {
          summary,
          routes: uniqueRoutes
        },
        message: `Found ${uniqueRoutes.length} routes`
      });
    }
  } catch (err) {
    logger.error('[GetAllRoutes]:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};