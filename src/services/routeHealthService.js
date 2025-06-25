import logger from '../logging/logger.js';
import { ROUTE_METADATA, getCurrentEnvironmentConfig } from '../config/routeConfig.js';

/**
 * Route Health Monitoring Service
 * Provides comprehensive health checking and monitoring for all routes
 */
export class RouteHealthService {
  constructor() {
    this.healthHistory = [];
    this.maxHistorySize = 100;
    this.lastHealthCheck = null;
  }

  /**
   * Performs comprehensive health check on all route modules
   * @param {Object} routes - Loaded route modules
   * @returns {Object} Detailed health status report
   */
  performHealthCheck(routes) {
    const healthReport = {
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      totalRoutes: Object.keys(ROUTE_METADATA).length,
      loadedRoutes: Object.keys(routes).length,
      healthyRoutes: 0,
      unhealthyRoutes: 0,
      stubRoutes: 0,
      criticalIssues: [],
      developmentRoutes: 0,
      routeStatus: {},
      categoryHealth: {},
      priorityHealth: {},
      overallHealth: 'unknown',
      recommendations: []
    };

    // Analyze each route
    for (const [routeName, metadata] of Object.entries(ROUTE_METADATA)) {
      const routeModule = routes[routeName];
      const routeHealth = this._analyzeRouteHealth(routeName, routeModule, metadata);
      
      healthReport.routeStatus[routeName] = routeHealth;
      
      // Update counters
      if (metadata.developmentOnly) {
        healthReport.developmentRoutes++;
      }
      
      switch (routeHealth.status) {
        case 'healthy':
          healthReport.healthyRoutes++;
          break;
        case 'stubbed':
          healthReport.stubRoutes++;
          break;
        case 'unhealthy':
        case 'error':
        case 'missing':
          healthReport.unhealthyRoutes++;
          if (metadata.priority === 'critical' && !metadata.developmentOnly) {
            healthReport.criticalIssues.push({
              route: routeName,
              issue: routeHealth.issue || 'Route module failed to load',
              priority: 'critical',
              impact: 'Service disruption',
              category: metadata.category
            });
          }
          break;
      }
    }

    // Pass the generated routeStatus to the calculation functions
    healthReport.categoryHealth = this._calculateCategoryHealth(healthReport.routeStatus);
    healthReport.priorityHealth = this._calculatePriorityHealth(healthReport.routeStatus);
    
    // Calculate overall health
    healthReport.overallHealth = this._calculateOverallHealth(healthReport);
    
    // Generate recommendations
    healthReport.recommendations = this._generateRecommendations(healthReport);
    
    // Store in history
    this._updateHealthHistory(healthReport);
    this.lastHealthCheck = healthReport;
    
    // Log results
    this._logHealthResults(healthReport);
    
    return healthReport;
  }

  /**
   * Analyzes health of a single route
   * @param {string} routeName - Name of the route
   * @param {Object} routeModule - The loaded route module
   * @param {Object} metadata - Route metadata from configuration
   * @returns {Object} Route health status
   */
  _analyzeRouteHealth(routeName, routeModule, metadata) {
    const routeHealth = {
      status: 'unknown',
      priority: metadata.priority,
      category: metadata.category,
      endpoints: metadata.endpoints,
      security: metadata.security,
      developmentOnly: metadata.developmentOnly || false,
      lastChecked: new Date().toISOString(),
      metrics: {}
    };

    try {
      if (!routeModule) {
        routeHealth.status = 'missing';
        routeHealth.issue = 'Route module not loaded or failed to import';
        return routeHealth;
      }
      
      // Get the actual router from the module
      // Routes can export in different ways: default export, named export, or direct export
      const router = routeModule.default || routeModule.router || routeModule;

      // Check for development stubs
      if (routeModule.__isDevelopmentStub || router.__isDevelopmentStub) {
        routeHealth.status = 'stubbed';
        routeHealth.issue = 'Development stub in production';
        routeHealth.metrics.isStub = true;
        return routeHealth;
      }
      
      // More flexible validation for Express routers
      // Express routers are functions with specific properties
      const isExpressRouter = router && (
        // Check if it's a function (basic requirement)
        typeof router === 'function' &&
        // Check for Express router properties
        (
          // Has stack property (routes have been defined)
          (Array.isArray(router.stack) && router.stack.length > 0) ||
          // Or has router methods (even if no routes defined yet)
          (typeof router.get === 'function' && typeof router.post === 'function') ||
          // Or has the express router signature
          router.name === 'router' ||
          // Or has _router property (some middleware patterns)
          router._router
        )
      );

      if (isExpressRouter) {
        routeHealth.status = 'healthy';
        routeHealth.metrics = {
          hasStack: Array.isArray(router.stack),
          stackSize: router.stack ? router.stack.length : 0,
          hasRouterMethods: typeof router.get === 'function',
          isStub: false
        };
      } else if (typeof router === 'function') {
        // It's a function but might be middleware or a different pattern
        // Consider it healthy if it's at least a function
        routeHealth.status = 'healthy';
        routeHealth.metrics = {
          isFunction: true,
          type: 'middleware-or-custom',
          isStub: false
        };
      } else {
        routeHealth.status = 'unhealthy';
        routeHealth.issue = 'Module loaded but does not export a valid Express router or middleware function';
        routeHealth.metrics = {
          exportType: typeof router,
          hasDefault: !!routeModule.default,
          hasRouter: !!routeModule.router,
          moduleKeys: Object.keys(routeModule).join(', ')
        };
      }
    } catch (err) {
      routeHealth.status = 'error';
      routeHealth.issue = err.message;
      routeHealth.error = {
        message: err.message,
        stack: err.stack
      };
    }

    return routeHealth;
  }

  /**
   * Calculates health by category using the status report
   */
  _calculateCategoryHealth(routeStatus) {
    const categoryHealth = {};
    
    for (const [routeName, health] of Object.entries(routeStatus)) {
      const category = health.category;
      if (!categoryHealth[category]) {
        categoryHealth[category] = { total: 0, healthy: 0, unhealthy: 0, stubbed: 0 };
      }
      
      categoryHealth[category].total++;
      
      switch (health.status) {
        case 'healthy':
          categoryHealth[category].healthy++;
          break;
        case 'stubbed':
          categoryHealth[category].stubbed++;
          break;
        default:
          categoryHealth[category].unhealthy++;
          break;
      }
    }
    
    // Calculate percentages
    for (const category of Object.keys(categoryHealth)) {
      const health = categoryHealth[category];
      const healthyCount = health.healthy + health.stubbed;
      health.healthPercentage = Math.round((healthyCount / health.total) * 100);
    }
    
    return categoryHealth;
  }

  /**
   * Calculates health by priority using the status report
   */
  _calculatePriorityHealth(routeStatus) {
    const priorityHealth = {};
    
    for (const [routeName, health] of Object.entries(routeStatus)) {
        const priority = health.priority;
        if (!priorityHealth[priority]) {
          priorityHealth[priority] = { total: 0, healthy: 0, unhealthy: 0, stubbed: 0 };
        }

        priorityHealth[priority].total++;
        
        switch (health.status) {
            case 'healthy':
              priorityHealth[priority].healthy++;
              break;
            case 'stubbed':
              priorityHealth[priority].stubbed++;
              break;
            default:
              priorityHealth[priority].unhealthy++;
              break;
        }
    }
    
    // Calculate percentages
    for (const priority of Object.keys(priorityHealth)) {
      const health = priorityHealth[priority];
      const healthyCount = health.healthy + health.stubbed;
      health.healthPercentage = Math.round((healthyCount / health.total) * 100);
    }
    
    return priorityHealth;
  }

  _calculateOverallHealth(healthReport) {
    const envConfig = getCurrentEnvironmentConfig();
    
    const relevantRoutes = envConfig.enableDevRoutes ? 
      healthReport.totalRoutes : 
      healthReport.totalRoutes - healthReport.developmentRoutes;
    
    if (relevantRoutes === 0) return 'excellent'; // Avoid division by zero
    
    const healthyCount = healthReport.healthyRoutes + healthReport.stubRoutes;
    const healthPercentage = (healthyCount / relevantRoutes) * 100;
    
    if (healthReport.criticalIssues.length > 0) {
      return 'critical';
    }
    
    if (healthPercentage >= 95) return 'excellent';
    if (healthPercentage >= 85) return 'good';
    if (healthPercentage >= 70) return 'degraded';
    return 'poor';
  }

  _generateRecommendations(healthReport) {
    const recommendations = [];
    
    if (healthReport.criticalIssues.length > 0) {
      recommendations.push({
        priority: 'urgent',
        type: 'critical-routes',
        message: `${healthReport.criticalIssues.length} critical routes are unhealthy`,
        action: 'Investigate and fix critical route loading issues immediately',
        routes: healthReport.criticalIssues.map(issue => issue.route)
      });
    }
    
    for (const [category, health] of Object.entries(healthReport.categoryHealth)) {
      if (health.healthPercentage < 80) {
        recommendations.push({
          priority: 'high',
          type: 'category-health',
          message: `${category} category has low health (${health.healthPercentage}%)`,
          action: `Review and fix routes in ${category} category`,
          category
        });
      }
    }
    
    if (process.env.NODE_ENV === 'development' && healthReport.stubRoutes > 0) {
      recommendations.push({
        priority: 'low',
        type: 'development',
        message: `${healthReport.stubRoutes} routes are using stubs`,
        action: 'Consider implementing missing route functionality',
        impact: 'Development experience'
      });
    }
    
    return recommendations;
  }

  _updateHealthHistory(healthReport) {
    this.healthHistory.push({
      timestamp: healthReport.timestamp,
      overallHealth: healthReport.overallHealth,
      healthyRoutes: healthReport.healthyRoutes,
      unhealthyRoutes: healthReport.unhealthyRoutes,
      criticalIssues: healthReport.criticalIssues.length
    });
    
    if (this.healthHistory.length > this.maxHistorySize) {
      this.healthHistory.shift();
    }
  }

  _logHealthResults(healthReport) {
    const totalRoutes = healthReport.loadedRoutes;
    const healthyCount = healthReport.healthyRoutes + healthReport.stubRoutes;
    const healthPercentage = totalRoutes > 0 ? Math.round((healthyCount / totalRoutes) * 100) : 100;
    
    logger.info(`[Route Health Check] ${healthyCount}/${totalRoutes} routes healthy (${healthPercentage}%) - Status: ${healthReport.overallHealth.toUpperCase()}`);
    
    if (healthReport.criticalIssues.length > 0) {
      logger.error(`[Route Health Check] ${healthReport.criticalIssues.length} critical issues detected:`, 
                    healthReport.criticalIssues.map(issue => issue.route).join(', '));
    }
    
    if (healthReport.recommendations.length > 0) {
      const urgentRecs = healthReport.recommendations.filter(rec => rec.priority === 'urgent');
      if (urgentRecs.length > 0) {
        logger.warn(`[Route Health Check] ${urgentRecs.length} urgent recommendations require attention`);
      }
    }
  }

  getHealthHistory(limit = 10) {
    return this.healthHistory.slice(-limit);
  }

  getLastHealthCheck() {
    return this.lastHealthCheck;
  }

  startHealthMonitoring(routes, interval = 300000) {
    const envConfig = getCurrentEnvironmentConfig();
    const checkInterval = interval || envConfig.healthCheckInterval;
    
    logger.info(`🔍 Starting route health monitoring (interval: ${checkInterval/1000}s)`);
    
    const intervalId = setInterval(() => {
      this.performHealthCheck(routes);
    }, checkInterval);
    
    return () => {
      clearInterval(intervalId);
      logger.info('🔍 Route health monitoring stopped');
    };
  }
}

export const routeHealthService = new RouteHealthService();