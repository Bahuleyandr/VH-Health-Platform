// utils/swaggerLoader.js

const path = require('path');
const YAML = require('yamljs');

/**
 * Loads the Swagger YAML file and returns the parsed document.
 * If loading fails, logs the error and returns null.
 * @returns {Object|null} Parsed Swagger document or null if loading fails.
 */
function loadSwaggerDocument() {
  try {
    const filePath = path.resolve(__dirname, '../docs/swagger.yaml');
    const swaggerDocument = YAML.load(filePath);
    return swaggerDocument;
  } catch (error) {
    console.error('Failed to load Swagger YAML file:', error.message);
    return null;
  }
}

module.exports = loadSwaggerDocument;
