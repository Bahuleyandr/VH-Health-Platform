// src/scripts/purgeLogs.js

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logsDir = path.join(__dirname, '../logs');

if (!fs.existsSync(logsDir)) {
  console.log('No logs directory found.');
  process.exit(0);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question(`Are you sure you want to purge all logs in ${logsDir}? (yes/no): `, answer => {
  if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
    const files = fs.readdirSync(logsDir);
    files.forEach(file => {
      const filePath = path.join(logsDir, file);
      fs.unlinkSync(filePath);
    });
    console.log('All logs have been purged.');
  } else {
    console.log('Purge cancelled.');
  }
  rl.close();
});
