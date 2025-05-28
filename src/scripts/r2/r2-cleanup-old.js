// src/scripts/r2-cleanup-old.js

import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { executeCleanup } from '../../utils/r2CleanupJob.js';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({
  path: path.resolve(__dirname, '../../.env.local'), // Adjust if you want .env.render or fallback
});

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
