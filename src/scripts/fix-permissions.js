// src/scripts/fix-permissions.js

const fs = require('fs');
const path = require('path');

const TARGET_DIRECTORIES = [
  path.join(__dirname, '../logs'),
  path.join(__dirname, '../backups')
];

TARGET_DIRECTORIES.forEach(dir => {
  if (fs.existsSync(dir)) {
    console.log(`🔧 Fixing permissions for ${dir}`);
    try {
      fs.chmodSync(dir, 0o755);
      console.log(`✅ Permissions set to 755 for ${dir}`);
    } catch (err) {
      console.error(`❌ Failed to fix permissions for ${dir}:`, err.message);
    }
  } else {
    console.warn(`⚠️ Directory not found: ${dir}`);
  }
});
