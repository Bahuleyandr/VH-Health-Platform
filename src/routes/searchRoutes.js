// src/routes/searchRoutes.js

import { Router } from 'express';
import { HTTP_STATUS } from '../config/responseCodes.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import {
  searchUsers,
  searchDoctors,
  searchAppointments,
  searchGlobal,
} from '../utils/search/searchService.js';

const router = Router();

// GET /api/v1/search?q=term&type=all|users|doctors|appointments&limit=20
router.get('/', async (req, res) => {
  try {
    const { q, type = 'all', limit = '20' } = req.query;

    if (!q || q.trim().length === 0) {
      return error(res, 'Search query "q" is required', HTTP_STATUS.BAD_REQUEST);
    }

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    let results;
    switch (type) {
      case 'users':
        results = { total: 0, results: await searchUsers(q, parsedLimit) };
        results.total = results.results.length;
        break;
      case 'doctors':
        results = { total: 0, results: await searchDoctors(q, parsedLimit) };
        results.total = results.results.length;
        break;
      case 'appointments':
        results = { total: 0, results: await searchAppointments(q, parsedLimit) };
        results.total = results.results.length;
        break;
      case 'all':
      default:
        results = await searchGlobal(q, parsedLimit);
        break;
    }

    success(res, results, `Found ${results.total} results`);
  } catch (err) {
    logger.error('Search route error:', err);
    error(res, 'Search failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
