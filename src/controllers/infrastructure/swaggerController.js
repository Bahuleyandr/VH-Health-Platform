// controllers/infrastructure/swaggerController.js
import { validationResult } from 'express-validator';
import YAML from 'yamljs';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { SwaggerService } from '../../services/infrastructure/swaggerService.js';
import { success, error } from '../../utils/responseHelper.js';

// Get OpenAPI specification (JSON)
export const getSpecJSON = async (req, res) => {
  try {
    const { swaggerDocument } = SwaggerService.getSwaggerDocument();
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    
    // Add metadata to the response
    const specWithMetadata = {
      ...swaggerDocument,
      'x-generated-at': new Date().toISOString(),
      'x-generator': 'VH Health API Documentation System v2.0',
      'x-spec-source': SwaggerService.swaggerCache?.loadError ? 'fallback' : 'file'
    };
    
    res.json(specWithMetadata);
  } catch (err) {
    logger.error('[GetSpecJSON]:', err);
    res.status(500).json({ 
      error: 'Failed to generate OpenAPI specification',
      details: err.message 
    });
  }
};

// Get OpenAPI specification (YAML)
export const getSpecYAML = async (req, res) => {
  try {
    const { swaggerDocument } = SwaggerService.getSwaggerDocument();
    
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Disposition', 'inline; filename="vh-health-api-spec.yaml"');
    
    const yamlString = YAML.stringify(swaggerDocument, 4);
    res.send(yamlString);
  } catch (err) {
    logger.error('[GetSpecYAML]:', err);
    res.status(500).json({ 
      error: 'Failed to generate YAML specification',
      details: err.message 
    });
  }
};

// Get API documentation statistics
export const getStats = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const { format = 'json' } = req.query;
    const stats = SwaggerService.getSwaggerStats(format);
    
    success(res, stats, 
      format === 'summary' 
        ? 'API documentation summary' 
        : 'API documentation statistics retrieved successfully'
    );
  } catch (err) {
    logger.error('[GetStats]:', err);
    error(res, 'Failed to generate documentation statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Validate OpenAPI specification
export const validateSpec = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const { strict = false } = req.query;
    const validation = SwaggerService.validateSwagger(strict);
    
    success(res, validation, validation.message);
  } catch (err) {
    logger.error('[ValidateSpec]:', err);
    error(res, 'Failed to validate OpenAPI specification', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get documentation health check
export const getDocHealth = async (req, res) => {
  try {
    const health = await SwaggerService.getDocumentationHealth();
    success(res, health, 'API documentation health check completed');
  } catch (err) {
    logger.error('[GetDocHealth]:', err);
    error(res, 'Documentation health check failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Discover API endpoints
export const discoverEndpoints = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const { tag, method } = req.query;
    const discovery = SwaggerService.discoverEndpoints(tag, method);
    
    success(res, discovery, 'API endpoints discovered successfully');
  } catch (err) {
    logger.error('[DiscoverEndpoints]:', err);
    error(res, 'Failed to discover API endpoints', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get documentation analytics (Admin only)
export const getSwaggerAnalytics = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const { timeframe = '30d' } = req.query;
    const analytics = await SwaggerService.getDocumentationAnalytics(timeframe);
    analytics.generatedBy = req.user?.name || 'System Admin';
    
    success(res, analytics, 'Documentation analytics retrieved successfully');
  } catch (err) {
    logger.error('[GetAnalytics]:', err);
    error(res, 'Failed to generate documentation analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Regenerate documentation (Admin only)
export const regenerateDoc = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      errors: errors.array()
    });
  }
  
  try {
    const { source = 'file', force = false } = req.body;
    const adminInfo = {
      uid: req.user?.uid,
      name: req.user?.name || 'System Admin',
      ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress
    };
    
    const result = await SwaggerService.regenerateDocumentation(source, force, adminInfo);
    
    if (result.regenerated) {
      success(res, result, 'Documentation regenerated successfully');
    } else {
      error(res, 'Failed to regenerate documentation', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  } catch (err) {
    logger.error('[RegenerateDoc]:', err);
    error(res, 'Failed to regenerate documentation', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};