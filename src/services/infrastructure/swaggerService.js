// services/infrastructure/swaggerService.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yamljs';
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';
import { 
  loadSwaggerDocument, 
  analyzeSwaggerDocument, 
  validateSwaggerDocument 
} from '../../utils/infrastructure/swaggerUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class SwaggerService {
  static swaggerCache = null;
  static cacheTimestamp = null;
  static CACHE_DURATION = 3600000; // 1 hour
  
  // Get or load Swagger document
  static getSwaggerDocument() {
    const now = Date.now();
    if (this.swaggerCache && this.cacheTimestamp && (now - this.cacheTimestamp < this.CACHE_DURATION)) {
      return this.swaggerCache;
    }
    
    const result = loadSwaggerDocument();
    this.swaggerCache = result;
    this.cacheTimestamp = now;
    return result;
  }
  
  // Get Swagger statistics
  static getSwaggerStats(format = 'json') {
    try {
      const { swaggerDocument } = this.getSwaggerDocument();
      const analysis = analyzeSwaggerDocument(swaggerDocument);
      
      if (format === 'summary') {
        return {
          title: swaggerDocument.info?.title,
          version: swaggerDocument.info?.version,
          totalEndpoints: analysis.overview.totalEndpoints,
          securityCoverage: `${analysis.overview.securityCoverage}%`,
          topMethods: Object.entries(analysis.methodBreakdown)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 3)
            .map(([method, count]) => `${method.toUpperCase()}: ${count}`),
          status: analysis.overview.totalEndpoints > 0 ? 'healthy' : 'no-endpoints'
        };
      }
      
      return {
        overview: analysis.overview,
        apiInfo: {
          title: swaggerDocument.info?.title || 'VH Health API',
          version: swaggerDocument.info?.version || '1.0.0',
          description: swaggerDocument.info?.description ? 'Available' : 'Not provided',
          specVersion: swaggerDocument.openapi || '3.0.0'
        },
        methodBreakdown: analysis.methodBreakdown,
        tagBreakdown: analysis.tagBreakdown,
        authentication: analysis.authentication,
        infrastructure: analysis.infrastructure,
        metadata: {
          lastUpdated: formatDateDDMMYYYY(new Date()),
          specSource: this.swaggerCache?.loadError ? 'fallback-generated' : 'file-loaded',
          loadError: this.swaggerCache?.loadError || null,
          generatedBy: 'VH Health Documentation System'
        }
      };
    } catch (error) {
      logger.error('Swagger stats error:', error);
      throw error;
    }
  }
  
  // Validate Swagger specification
  static validateSwagger(strict = false) {
    try {
      const { swaggerDocument } = this.getSwaggerDocument();
      const validation = validateSwaggerDocument(swaggerDocument, strict);
      
      // Add specification info
      validation.info = {
        specVersion: swaggerDocument.openapi || 'unknown',
        pathCount: Object.keys(swaggerDocument.paths || {}).length,
        schemaCount: Object.keys(swaggerDocument.components?.schemas || {}).length,
        securitySchemeCount: Object.keys(swaggerDocument.components?.securitySchemes || {}).length,
        serverCount: (swaggerDocument.servers || []).length,
        tagCount: (swaggerDocument.tags || []).length,
        hasExternalDocs: !!swaggerDocument.externalDocs,
        estimatedComplexity: validation.info?.pathCount > 50 ? 'high' : 
                            validation.info?.pathCount > 20 ? 'medium' : 'low'
      };
      
      const status = validation.valid ? 'valid' : 'invalid';
      const message = validation.valid 
        ? `OpenAPI specification is valid${validation.warnings.length > 0 ? ` with ${validation.warnings.length} warning(s)` : ''}`
        : `OpenAPI specification has ${validation.errors.length} error(s)`;
        
      return {
        status,
        validation,
        validatedAt: formatDateDDMMYYYY(new Date()),
        strictMode: strict,
        specSource: this.swaggerCache?.loadError ? 'fallback' : 'file',
        message
      };
    } catch (error) {
      logger.error('Swagger validation error:', error);
      throw error;
    }
  }
  
  // Get documentation health
  static async getDocumentationHealth() {
    try {
      const { swaggerDocument, loadError } = this.getSwaggerDocument();
      const analysis = analyzeSwaggerDocument(swaggerDocument);
      
      const health = {
        status: 'healthy',
        documentation: {
          available: true,
          format: 'OpenAPI 3.0+',
          uiAvailable: true,
          specFormats: ['JSON', 'YAML'],
          source: loadError ? 'generated' : 'file'
        },
        endpoints: {
          total: analysis.overview.totalEndpoints,
          documented: true,
          authRequired: !!(swaggerDocument.security && swaggerDocument.security.length > 0),
          publicEndpoints: analysis.overview.totalEndpoints - analysis.overview.securedEndpoints
        },
        features: {
          interactiveUI: true,
          downloadableSpec: true,
          validation: true,
          statistics: true,
          searching: true,
          filtering: true
        },
        metadata: {
          title: swaggerDocument.info?.title,
          version: swaggerDocument.info?.version,
          lastModified: formatDateDDMMYYYY(new Date()),
          loadSource: loadError ? 'fallback-generated' : 'swagger.yaml',
          specSize: JSON.stringify(swaggerDocument).length
        }
      };
      
      // Add warnings
      const warnings = [];
      if (loadError) {
        warnings.push('Original swagger.yaml file could not be loaded, using fallback documentation');
      }
      if (health.endpoints.total === 0) {
        warnings.push('No API endpoints documented');
        health.status = 'degraded';
      }
      
      if (warnings.length > 0) {
        health.warnings = warnings;
      }
      
      return health;
    } catch (error) {
      logger.error('Documentation health check error:', error);
      throw error;
    }
  }
  
  // Discover API endpoints
  static discoverEndpoints(tag = null, method = null) {
    try {
      const { swaggerDocument } = this.getSwaggerDocument();
      const paths = swaggerDocument.paths || {};
      const endpoints = [];
      
      Object.entries(paths).forEach(([path, pathObj]) => {
        Object.entries(pathObj).forEach(([httpMethod, operation]) => {
          if (['get', 'post', 'put', 'patch', 'delete'].includes(httpMethod)) {
            // Apply filters
            if (method && httpMethod.toUpperCase() !== method.toUpperCase()) {
              return;
            }
            
            if (tag && (!operation.tags || !operation.tags.includes(tag))) {
              return;
            }
            
            endpoints.push({
              path,
              method: httpMethod.toUpperCase(),
              summary: operation.summary || 'No summary available',
              description: operation.description || 'No description available',
              tags: operation.tags || [],
              deprecated: operation.deprecated || false,
              requiresAuth: !!(operation.security || swaggerDocument.security),
              parameters: (operation.parameters || []).map(param => ({
                name: param.name,
                in: param.in,
                required: param.required || false,
                type: param.schema?.type || 'unknown'
              })),
              requestBody: operation.requestBody ? {
                required: operation.requestBody.required || false,
                contentTypes: Object.keys(operation.requestBody.content || {})
              } : null,
              responses: Object.keys(operation.responses || {})
            });
          }
        });
      });
      
      // Sort endpoints by path and method
      endpoints.sort((a, b) => {
        if (a.path !== b.path) {return a.path.localeCompare(b.path);}
        return a.method.localeCompare(b.method);
      });
      
      const availableTags = [...new Set(
        Object.values(paths)
          .flatMap(pathObj => 
            Object.values(pathObj)
              .filter(op => typeof op === 'object' && op.tags)
              .flatMap(op => op.tags)
          )
      )].sort();
      
      return {
        totalEndpoints: endpoints.length,
        filteredBy: { tag, method },
        availableTags,
        availableMethods: [...new Set(endpoints.map(e => e.method))].sort(),
        endpoints
      };
    } catch (error) {
      logger.error('API discovery error:', error);
      throw error;
    }
  }
  
  // Get documentation analytics
  static async getDocumentationAnalytics(timeframe = '30d') {
    try {
      // Get documentation access logs if available
      let accessStats = null;
      try {
        const accessResult = await db.query(`
          SELECT 
            DATE(created_at) as date,
            COUNT(*) as views,
            COUNT(DISTINCT ip_address) as unique_visitors
          FROM api_access_logs 
          WHERE endpoint LIKE '/api-docs%' 
            AND created_at >= NOW() - INTERVAL '30 days'
          GROUP BY DATE(created_at)
          ORDER BY date DESC
          LIMIT 30
        `);
        
        accessStats = {
          dailyViews: accessResult.rows,
          totalViews: accessResult.rows.reduce((sum, row) => sum + parseInt(row.views), 0),
          uniqueVisitors: accessResult.rows.reduce((sum, row) => sum + parseInt(row.unique_visitors), 0)
        };
      } catch (accessError) {
        logger.warn('Documentation access stats unavailable:', accessError.message);
      }
      
      // Analyze current documentation
      const { swaggerDocument } = this.getSwaggerDocument();
      const analysis = analyzeSwaggerDocument(swaggerDocument);
      
      const analytics = {
        overview: analysis.overview,
        usage: accessStats,
        recommendations: [],
        healthScore: 0
      };
      
      // Generate recommendations
      if (analytics.overview.documentationCoverage < 80) {
        analytics.recommendations.push({
          type: 'documentation',
          priority: 'high',
          message: `${analytics.overview.totalEndpoints - analytics.overview.documentedEndpoints} endpoints need documentation`
        });
      }
      
      if (analytics.overview.securityCoverage < 90) {
        analytics.recommendations.push({
          type: 'security',
          priority: 'medium',
          message: 'Consider adding security requirements to more endpoints'
        });
      }
      
      if (analytics.overview.deprecatedEndpoints > 0) {
        analytics.recommendations.push({
          type: 'maintenance',
          priority: 'medium',
          message: `${analytics.overview.deprecatedEndpoints} deprecated endpoints should be reviewed`
        });
      }
      
      // Calculate health score (0-100)
      analytics.healthScore = Math.round(
        (analytics.overview.documentationCoverage * 0.4) +
        (analytics.overview.securityCoverage * 0.3) +
        ((analytics.overview.totalEndpoints > 0 ? 1 : 0) * 30)
      );
      
      analytics.metadata = {
        timeframe,
        generatedAt: formatDateDDMMYYYY(new Date()),
        specSource: this.swaggerCache?.loadError ? 'fallback' : 'file'
      };
      
      return analytics;
    } catch (error) {
      logger.error('Documentation analytics error:', error);
      throw error;
    }
  }
  
  // Regenerate documentation
  static async regenerateDocumentation(source = 'file', force = false, adminInfo) {
    try {
      const regenerationResult = {
        success: false,
        source: 'unknown',
        oldEndpointCount: 0,
        newEndpointCount: 0,
        errors: []
      };
      
      // Get current endpoint count
      const { swaggerDocument: currentDoc } = this.getSwaggerDocument();
      regenerationResult.oldEndpointCount = Object.keys(currentDoc.paths || {}).length;
      
      if (source === 'file' || !force) {
        // Try to reload from file
        try {
          const swaggerPath = path.join(__dirname, '../../docs/swagger.yaml');
          
          if (fs.existsSync(swaggerPath)) {
            const newSwaggerDocument = YAML.load(swaggerPath);
            
            // Clear cache
            this.swaggerCache = null;
            this.cacheTimestamp = null;
            
            regenerationResult.success = true;
            regenerationResult.source = 'file';
            regenerationResult.newEndpointCount = Object.keys(newSwaggerDocument.paths || {}).length;
            
            logger.info(`📚 Swagger documentation reloaded from file by ${adminInfo.name}`);
          } else {
            regenerationResult.errors.push('swagger.yaml file not found');
          }
        } catch (fileError) {
          regenerationResult.errors.push(`Failed to load from file: ${fileError.message}`);
        }
      }
      
      if (!regenerationResult.success && (source === 'fallback' || force)) {
        // Clear cache to force regeneration
        this.swaggerCache = null;
        this.cacheTimestamp = null;
        
        const { swaggerDocument: newDoc } = this.getSwaggerDocument();
        
        regenerationResult.success = true;
        regenerationResult.source = 'fallback';
        regenerationResult.newEndpointCount = Object.keys(newDoc.paths || {}).length;
        
        logger.info(`📚 Swagger documentation regenerated using fallback by ${adminInfo.name}`);
      }
      
      // Log regeneration activity
      await db.query(
        `INSERT INTO admin_activity_logs (
          admin_uid, action, description, details, 
          ip_address, created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          adminInfo.uid,
          'DOCUMENTATION_REGENERATED',
          `API documentation regenerated from ${regenerationResult.source}`,
          JSON.stringify(regenerationResult),
          adminInfo.ipAddress
        ]
      ).catch(err => logger.warn('Could not log regeneration activity:', err.message));
      
      return {
        regenerated: regenerationResult.success,
        source: regenerationResult.source,
        endpointCount: {
          before: regenerationResult.oldEndpointCount,
          after: regenerationResult.newEndpointCount,
          change: regenerationResult.newEndpointCount - regenerationResult.oldEndpointCount
        },
        regeneratedAt: formatDateDDMMYYYY(new Date()),
        regeneratedBy: adminInfo.name,
        errors: regenerationResult.errors
      };
    } catch (error) {
      logger.error('Documentation regeneration error:', error);
      throw error;
    }
  }
}