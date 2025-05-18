// list-logs.js
const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, 'src', 'logs');

if (!fs.existsSync(logDir)) {
  console.log('Logs directory does not exist.');
  process.exit(0);
}

const files = fs.readdirSync(logDir);
if (files.length === 0) {
  console.log('No log files found.');
} else {
  console.log('Log files:');
  files.forEach(file => console.log(file));
}
