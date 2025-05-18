// purgeLogs.js
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const logsDir = path.join(__dirname, 'src', 'logs');

if (!fs.existsSync(logsDir)) {
  console.log('No logs directory found.');
  process.exit(0);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question(`Are you sure you want to purge all logs in ${logsDir}? (yes/no): `, (answer) => {
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
