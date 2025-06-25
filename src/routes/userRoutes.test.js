// Minimal test userRoutes to isolate the issue
import express from 'express';
import db from '../config/database.js';
import { success, error } from '../utils/responseHelper.js';

const router = express.Router();

// Simple test route
router.get('/test', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW() as current_time');
    success(res, result.rows[0], 'Database test successful');
  } catch (err) {
    error(res, 'Database test failed');
  }
});

console.log('✅ Test userRoutes loaded successfully');
export default router;