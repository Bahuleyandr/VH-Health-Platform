// src/scripts/list-logs.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logDir = path.join(__dirname, '../logs');

if (!fs.existsSync(logDir)) {
  console.log('Logs directory does not exist.');
  process.exit(0);
}

const files = fs.readdirSync(logDir);
if (files.length === 0) {
  console.log('No log files found.');
} else {
  console.log('Log files:');
  files.forEach((file) => console.log(file));
}
