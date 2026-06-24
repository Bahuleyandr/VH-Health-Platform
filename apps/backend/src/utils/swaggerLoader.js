// src/utils/swaggerLoader.js

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from '../logging/logger.js';

// ESM Replacement for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Loads the canonical OpenAPI JSON spec and returns the parsed document.
 * If loading fails, logs the error and returns null.
 * @returns {Object|null} Parsed OpenAPI document or null if loading fails.
 */
export default function loadSwaggerDocument() {
  try {
    const filePath = path.resolve(__dirname, '../docs/openapi.json');
    const swaggerDocument = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return swaggerDocument;
  } catch (error) {
    logger.error('Failed to load OpenAPI spec file:', error.message);
    return null;
  }
}
