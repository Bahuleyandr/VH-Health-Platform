#!/usr/bin/env node

// src/scripts/upgrade-sdk.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageJsonPath = path.resolve(__dirname, '../../package.json');

if (!fs.existsSync(packageJsonPath)) {
  console.error('❌ package.json not found.');
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

if (!packageJson.dependencies) {
  console.error('❌ No dependencies found in package.json.');
  process.exit(1);
}

console.log('🔄 Updating AWS SDK packages...');
packageJson.dependencies['@aws-sdk/client-s3'] = '^3.532.0';
packageJson.dependencies['@aws-sdk/s3-request-presigner'] = '^3.532.0';
packageJson.dependencies['@aws-sdk/util-create-request'] = '^3.532.0';

if (packageJson.dependencies['aws-sdk']) {
  console.log('🚮 Removing deprecated aws-sdk v2...');
  delete packageJson.dependencies['aws-sdk'];
}

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
console.log(
  '✅ package.json updated successfully. Please run npm install to apply changes.',
);
