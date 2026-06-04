// src/scripts/generate-swagger.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const swaggerFilePath = path.join(__dirname, '../docs/swagger.yaml');
const outputJsonPath = path.join(__dirname, '../docs/swagger.json');

// Check if swagger.yaml exists
if (!fs.existsSync(swaggerFilePath)) {
  console.error('❌ swagger.yaml not found at src/docs/swagger.yaml');
  process.exit(1);
}

try {
  // Load and parse the YAML
  const swaggerYaml = YAML.parse(fs.readFileSync(swaggerFilePath, 'utf8'));

  // Convert to JSON and write it to swagger.json
  fs.writeFileSync(outputJsonPath, JSON.stringify(swaggerYaml, null, 2));

  console.log('✅ swagger.json generated successfully at src/docs/swagger.json');
} catch (error) {
  console.error('❌ Failed to generate swagger.json:', error.message);
  process.exit(1);
}
