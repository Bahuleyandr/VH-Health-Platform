// src/config/sourceMapConfig.js
const isDevelopment = process.env.NODE_ENV === 'development';
const isTest = process.env.NODE_ENV === 'test';

export const sourceMapConfig = {
  enabled: isDevelopment || isTest || process.env.ENABLE_SOURCE_MAPS === 'true',
  
  options: {
    environment: 'node',
    handleUncaughtExceptions: !isDevelopment, // Only in production
    hookRequire: true,
    
    // Custom retrieval for production (if using external service)
    retrieveSourceMap: process.env.SOURCE_MAP_URL ? (source) => {
      // Implement custom source map retrieval
      // e.g., from S3, CDN, or error tracking service
      return null;
    } : null
  }
};

// Initialize source maps
export const initializeSourceMaps = () => {
  if (sourceMapConfig.enabled) {
    require('source-map-support').install(sourceMapConfig.options);
    console.log('✅ Source map support enabled');
  }
};