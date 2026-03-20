// src/utils/swaggerLoader.js

import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yamljs';
import logger from '../logging/logger.js';

// ESM Replacement for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Loads the Swagger YAML file and returns the parsed document.
 * If loading fails, logs the error and returns null.
 * @returns {Object|null} Parsed Swagger document or null if loading fails.
 */
export default function loadSwaggerDocument() {
  try {
    const filePath = path.resolve(__dirname, '../docs/swagger.yaml');
    const swaggerDocument = YAML.load(filePath);
    return swaggerDocument;
  } catch (error) {
    logger.error('Failed to load Swagger YAML file:', error.message);
    return null;
  }
}
