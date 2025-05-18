// generate-swagger.js
const fs = require('fs');
const path = require('path');
const YAML = require('yamljs');

const swaggerFilePath = path.join(__dirname, 'src', 'docs', 'swagger.yaml');
const outputJsonPath = path.join(__dirname, 'src', 'docs', 'swagger.json');

// Check if swagger.yaml exists
if (!fs.existsSync(swaggerFilePath)) {
  console.error('❌ swagger.yaml not found at src/docs/swagger.yaml');
  process.exit(1);
}

try {
  // Load and parse the YAML
  const swaggerYaml = YAML.load(swaggerFilePath);

  // Convert to JSON and write it to swagger.json
  fs.writeFileSync(outputJsonPath, JSON.stringify(swaggerYaml, null, 2));

  console.log('✅ swagger.json generated successfully at src/docs/swagger.json');
} catch (error) {
  console.error('❌ Failed to generate swagger.json:', error.message);
  process.exit(1);
}
