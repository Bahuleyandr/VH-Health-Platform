// src/services/routeDocumentationService.js
// Route Documentation Generation Service

import { ROUTE_METADATA, CATEGORY_DESCRIPTIONS, getCurrentEnvironmentConfig } from '../config/routeConfig.js';
import logger from '../logging/logger.js';

/**
 * Route Documentation Service
 * Generates comprehensive documentation for all routes
 */
export class RouteDocumentationService {
  constructor() {
    this.lastGenerated = null;
  }

  /**
   * Generates comprehensive route documentation
   * @param {Object} routes - Loaded route modules
   * @returns {Object} Complete route documentation
   */
  generateDocumentation(routes) {
    const documentation = {
      metadata: {
        generated: new Date().toISOString(),
        generator: 'VH Health Route Documentation Service',
        apiVersion: '1.0.0',
        environment: process.env.NODE_ENV || 'development'
      },
      overview: this._generateOverview(routes),
      categories: this._generateCategoryDocumentation(routes),
      securityLevels: this._generateSecurityDocumentation(routes),
      priorities: this._generatePriorityDocumentation(routes),
      routes: this._generateRouteDetails(routes),
      statistics: this._generateStatistics(routes),
      healthMetrics: this._generateHealthMetrics(routes)
    };

    this.lastGenerated = documentation;
    logger.info('📚 Route documentation generated successfully');
    
    return documentation;
  }

  /**
   * Generates overview section
   * @param {Object} routes - Loaded routes
   * @returns {Object} Overview information
   */
  _generateOverview(routes) {
    const totalEndpoints = Object.values(ROUTE_METADATA)
      .reduce((sum, meta) => sum + meta.endpoints, 0);
    
    const loadedRoutes = Object.keys(routes).length;
    const availableRoutes = Object.keys(ROUTE_METADATA).length;
    
    return {
      totalRoutes: availableRoutes,
      loadedRoutes: loadedRoutes,
      totalEndpoints: totalEndpoints,
      loadingPercentage: Math.round((loadedRoutes / availableRoutes) * 100),
      description: 'VH Health Backend API - Hospital-grade healthcare management system',
      features: [
        'Comprehensive patient management',
        'HIPAA-compliant medical records',
        'Real-time appointment scheduling',
        'Emergency response system',
        'Role-based access control',
        'Advanced file management',
        'Comprehensive audit logging'
      ]
    };
  }

  /**
   * Generates category-based documentation
   * @param {Object} routes - Loaded routes
   * @returns {Object} Category documentation
   */
  _generateCategoryDocumentation(routes) {
    const categories = {};
    
    for (const [routeName, metadata] of Object.entries(ROUTE_METADATA)) {
      const category = metadata.category;
      
      if (!categories[category]) {
        categories[category] = {
          description: CATEGORY_DESCRIPTIONS[category] || 'General system functionality',
          routes: [],
          totalEndpoints: 0,
          status: 'unknown',
          features: []
        };
      }
      
      const route = routes[routeName];
      const routeStatus = this._getRouteStatus(route);
      
      categories[category].routes.push({
        name: routeName,
        description: metadata.description,
        endpoints: metadata.endpoints,
        priority: metadata.priority,
        security: metadata.security,
        status: routeStatus,
        developmentOnly: metadata.developmentOnly || false
      });
      
      categories[category].totalEndpoints += metadata.endpoints;
      
      // Add features based on route descriptions
      this._extractFeaturesFromDescription(metadata.description, categories[category].features);
    }
    
    // Calculate category status
    for (const category of Object.keys(categories)) {
      categories[category].status = this._calculateCategoryStatus(categories[category].routes);
    }
    
    return categories;
  }

  /**
   * Generates security-based documentation
   * @param {Object} routes - Loaded routes
   * @returns {Object} Security documentation
   */
  _generateSecurityDocumentation(routes) {
    const securityLevels = {};
    
    for (const [routeName, metadata] of Object.entries(ROUTE_METADATA)) {
      const security = metadata.security;
      
      if (!securityLevels[security]) {
        securityLevels[security] = {
          routes: [],
          description: this._getSecurityDescription(security),
          accessLevel: this._getAccessLevel(security),
          requirements: this._getSecurityRequirements(security)
        };
      }
      
      const route = routes[routeName];
      const routeStatus = this._getRouteStatus(route);
      
      securityLevels[security].routes.push({
        name: routeName,
        category: metadata.category,
        priority: metadata.priority,
        status: routeStatus,
        endpoints: metadata.endpoints
      });
    }
    
    return securityLevels;
  }

  /**
   * Generates priority-based documentation
   * @param {Object} routes - Loaded routes
   * @returns {Object} Priority documentation
   */
  _generatePriorityDocumentation(routes) {
    const priorities = {};
    
    for (const [routeName, metadata] of Object.entries(ROUTE_METADATA)) {
      const priority = metadata.priority;
      
      if (!priorities[priority]) {
        priorities[priority] = {
          routes: [],
          description: this._getPriorityDescription(priority),
          impactLevel: this._getImpactLevel(priority),
          recommendedSLA: this._getRecommendedSLA(priority)
        };
      }
      
      const route = routes[routeName];
      const routeStatus = this._getRouteStatus(route);
      
      priorities[priority].routes.push({
        name: routeName,
        category: metadata.category,
        security: metadata.security,
        status: routeStatus,
        endpoints: metadata.endpoints
      });
    }
    
    return priorities;
  }

  /**
   * Generates detailed route information
   * @param {Object} routes - Loaded routes
   * @returns {Object} Detailed route documentation
   */
  _generateRouteDetails(routes) {
    const routeDetails = {};
    
    for (const [routeName, metadata] of Object.entries(ROUTE_METADATA)) {
      const route = routes[routeName];
      
      routeDetails[routeName] = {
        description: metadata.description,
        category: metadata.category,
        priority: metadata.priority,
        endpoints: metadata.endpoints,
        security: metadata.security,
        healthMonitored: metadata.healthCheck,
        developmentOnly: metadata.developmentOnly || false,
        status: this._getRouteStatus(route),
        implementation: this._analyzeRouteImplementation(route),
        dependencies: this._analyzeDependencies(routeName),
        usageGuidelines: this._generateUsageGuidelines(metadata)
      };
    }
    
    return routeDetails;
  }

  /**
   * Generates statistics
   * @param {Object} routes - Loaded routes
   * @returns {Object} Route statistics
   */
  _generateStatistics(routes) {
    const stats = {
      byCategory: {},
      byPriority: {},
      bySecurity: {},
      byStatus: {
        healthy: 0,
        stubbed: 0,
        unhealthy: 0,
        missing: 0
      },
      endpoints: {
        total: 0,
        byCategory: {},
        byPriority: {}
      }
    };
    
    for (const [routeName, metadata] of Object.entries(ROUTE_METADATA)) {
      const route = routes[routeName];
      const status = this._getRouteStatus(route);
      
      // Count by category
      stats.byCategory[metadata.category] = (stats.byCategory[metadata.category] || 0) + 1;
      
      // Count by priority
      stats.byPriority[metadata.priority] = (stats.byPriority[metadata.priority] || 0) + 1;
      
      // Count by security
      stats.bySecurity[metadata.security] = (stats.bySecurity[metadata.security] || 0) + 1;
      
      // Count by status
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
      
      // Endpoint statistics
      stats.endpoints.total += metadata.endpoints;
      stats.endpoints.byCategory[metadata.category] = 
        (stats.endpoints.byCategory[metadata.category] || 0) + metadata.endpoints;
      stats.endpoints.byPriority[metadata.priority] = 
        (stats.endpoints.byPriority[metadata.priority] || 0) + metadata.endpoints;
    }
    
    return stats;
  }

  /**
   * Generates health metrics
   * @param {Object} routes - Loaded routes
   * @returns {Object} Health metrics
   */
  _generateHealthMetrics(routes) {
    const total = Object.keys(ROUTE_METADATA).length;
    const loaded = Object.keys(routes).length;
    const healthy = Object.values(routes).filter(route => 
      route && !route.__isDevelopmentStub && typeof route === 'object'
    ).length;
    const stubbed = Object.values(routes).filter(route => 
      route && route.__isDevelopmentStub
    ).length;
    
    return {
      loadingRate: Math.round((loaded / total) * 100),
      healthRate: Math.round((healthy / loaded) * 100),
      stubRate: Math.round((stubbed / loaded) * 100),
      recommendations: this._generateHealthRecommendations(routes),
      lastUpdate: new Date().toISOString()
    };
  }

  // Helper methods
  _getRouteStatus(route) {
    if (!route) {return 'missing';}
    if (route.__isDevelopmentStub) {return 'stubbed';}
    if (typeof route === 'object' && (route.stack || typeof route.use === 'function')) {return 'healthy';}
    return 'unhealthy';
  }

  _calculateCategoryStatus(routes) {
    const healthyCount = routes.filter(r => r.status === 'healthy' || r.status === 'stubbed').length;
    const healthPercentage = (healthyCount / routes.length) * 100;
    
    if (healthPercentage >= 90) {return 'excellent';}
    if (healthPercentage >= 75) {return 'good';}
    if (healthPercentage >= 50) {return 'fair';}
    return 'poor';
  }

  _getSecurityDescription(security) {
    const descriptions = {
      'public': 'Publicly accessible endpoints',
      'public + admin': 'Public access with admin capabilities',
      'public + monitored': 'Public access with security monitoring',
      'user + admin': 'User and admin access',
      'multi-role': 'Multiple role-based access',
      'admin only': 'Administrator access only',
      'staff + admin': 'Staff and administrator access',
      'development only': 'Development environment only',
      'role-based': 'Role-based access control',
      'hipaa-compliant': 'HIPAA compliant medical data access',
      'emergency system': 'Emergency response system access'
    };
    return descriptions[security] || 'Custom security configuration';
  }

  _getAccessLevel(security) {
    if (security.includes('public')) {return 'open';}
    if (security.includes('admin only')) {return 'restricted';}
    if (security.includes('development')) {return 'development';}
    return 'controlled';
  }

  _getSecurityRequirements(security) {
    const requirements = [];
    if (security.includes('admin')) {requirements.push('Admin privileges required');}
    if (security.includes('monitored')) {requirements.push('Security monitoring enabled');}
    if (security.includes('hipaa')) {requirements.push('HIPAA compliance required');}
    if (security.includes('role-based')) {requirements.push('Role-based authorization');}
    return requirements;
  }

  _getPriorityDescription(priority) {
    const descriptions = {
      'critical': 'Essential for system operation - immediate attention required if failing',
      'high': 'Important functionality - should be prioritized for fixes',
      'medium': 'Standard functionality - normal maintenance priority',
      'low': 'Optional or development features - low maintenance priority'
    };
    return descriptions[priority] || 'Standard priority';
  }

  _getImpactLevel(priority) {
    const impacts = {
      'critical': 'System failure',
      'high': 'Feature disruption',
      'medium': 'Reduced functionality',
      'low': 'Minor impact'
    };
    return impacts[priority] || 'Unknown impact';
  }

  _getRecommendedSLA(priority) {
    const slas = {
      'critical': '99.9% uptime',
      'high': '99.5% uptime',
      'medium': '99% uptime',
      'low': '95% uptime'
    };
    return slas[priority] || 'No SLA defined';
  }

  _analyzeRouteImplementation(route) {
    if (!route) {return { type: 'missing', details: 'Route not implemented' };}
    if (route.__isDevelopmentStub) {return { type: 'stub', details: 'Development stub implementation' };}
    
    return {
      type: 'express-router',
      details: 'Full Express.js router implementation',
      hasStack: Array.isArray(route.stack),
      stackSize: route.stack ? route.stack.length : 0,
      hasMiddleware: typeof route.use === 'function'
    };
  }

  _analyzeDependencies(routeName) {
    // This could be enhanced to analyze actual dependencies
    const commonDeps = ['express', 'validation', 'database', 'logging'];
    const securityDeps = ['rbac', 'authentication', 'rate-limiting'];
    
    return {
      common: commonDeps,
      security: securityDeps,
      specific: [] // Could be populated with route-specific analysis
    };
  }

  _generateUsageGuidelines(metadata) {
    const guidelines = [];
    
    if (metadata.priority === 'critical') {
      guidelines.push('Monitor closely for availability');
      guidelines.push('Implement proper error handling');
    }
    
    if (metadata.security.includes('admin')) {
      guidelines.push('Ensure proper admin authentication');
      guidelines.push('Log all administrative actions');
    }
    
    if (metadata.category === 'medical') {
      guidelines.push('Follow HIPAA compliance guidelines');
      guidelines.push('Implement data encryption');
    }
    
    return guidelines;
  }

  _extractFeaturesFromDescription(description, features) {
    // Simple feature extraction based on keywords
    const keywords = {
      'authentication': ['login', 'auth', 'verification'],
      'scheduling': ['appointment', 'booking', 'calendar'],
      'medical records': ['record', 'medical', 'hipaa'],
      'notifications': ['notification', 'alert', 'message'],
      'administration': ['admin', 'management', 'control']
    };
    
    for (const [feature, terms] of Object.entries(keywords)) {
      if (terms.some(term => description.toLowerCase().includes(term))) {
        if (!features.includes(feature)) {
          features.push(feature);
        }
      }
    }
  }

  _generateHealthRecommendations(routes) {
    const recommendations = [];
    const unhealthyCount = Object.values(routes).filter(route => 
      !route || (!route.__isDevelopmentStub && typeof route !== 'object')
    ).length;
    
    if (unhealthyCount > 0) {
      recommendations.push(`Fix ${unhealthyCount} unhealthy routes`);
    }
    
    const envConfig = getCurrentEnvironmentConfig();
    if (envConfig.enableDevRoutes) {
      recommendations.push('Review development routes for production readiness');
    }
    
    return recommendations;
  }

  /**
   * Exports documentation to different formats
   * @param {Object} documentation - Documentation object
   * @param {string} format - Export format (json, markdown, html)
   * @returns {string} Formatted documentation
   */
  exportDocumentation(documentation, format = 'json') {
    switch (format.toLowerCase()) {
      case 'json':
        return JSON.stringify(documentation, null, 2);
      
      case 'markdown':
        return this._generateMarkdownDocumentation(documentation);
      
      case 'html':
        return this._generateHtmlDocumentation(documentation);
      
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  _generateMarkdownDocumentation(doc) {
    let markdown = `# VH Health API Documentation\n\n`;
    markdown += `Generated: ${doc.metadata.generated}\n\n`;
    markdown += `## Overview\n\n`;
    markdown += `- Total Routes: ${doc.overview.totalRoutes}\n`;
    markdown += `- Total Endpoints: ${doc.overview.totalEndpoints}\n`;
    markdown += `- Loading Rate: ${doc.overview.loadingPercentage}%\n\n`;
    
    // Add categories
    markdown += `## Categories\n\n`;
    for (const [category, info] of Object.entries(doc.categories)) {
      markdown += `### ${category}\n`;
      markdown += `${info.description}\n\n`;
      markdown += `Routes: ${info.routes.length} | Endpoints: ${info.totalEndpoints}\n\n`;
    }
    
    return markdown;
  }

  _generateHtmlDocumentation(doc) {
    return `
<!DOCTYPE html>
<html>
<head>
    <title>VH Health API Documentation</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .category { margin: 20px 0; padding: 15px; border-left: 4px solid #007cba; }
        .route { margin: 10px 0; padding: 10px; background: #f5f5f5; }
        .status-healthy { color: green; }
        .status-unhealthy { color: red; }
        .status-stubbed { color: orange; }
    </style>
</head>
<body>
    <h1>VH Health API Documentation</h1>
    <p>Generated: ${doc.metadata.generated}</p>
    <h2>Overview</h2>
    <ul>
        <li>Total Routes: ${doc.overview.totalRoutes}</li>
        <li>Total Endpoints: ${doc.overview.totalEndpoints}</li>
        <li>Loading Rate: ${doc.overview.loadingPercentage}%</li>
    </ul>
    <!-- Additional HTML content would be generated here -->
</body>
</html>`;
  }

  /**
   * Gets last generated documentation
   * @returns {Object|null} Last documentation
   */
  getLastDocumentation() {
    return this.lastGenerated;
  }
}

// Export singleton instance
export const routeDocumentationService = new RouteDocumentationService();