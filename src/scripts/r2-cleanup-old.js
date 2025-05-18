// src/scripts/r2-cleanup-old.js

const path = require('path');

// Load environment variables
require('dotenv').config({
  path: path.resolve(__dirname, '../../.env.local') // Adjust if you want .env.render or fallback
});

const { executeCleanup } = require('../utils/r2CleanupJob');

(async () => {
  console.log('🔄 Manual R2 cleanup started...');
  try {
    await executeCleanup();
    console.log('✅ Manual R2 cleanup completed.');
  } catch (error) {
    console.error('❌ Manual R2 cleanup failed:', error);
    process.exit(1);
  }
})();
