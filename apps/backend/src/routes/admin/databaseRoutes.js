import express from 'express';
import logger from '../../logging/logger.js';
import {
  getDatabaseOverview,
  getTableDetail,
  getTableRows,
} from '../../services/databaseIntrospectionService.js';
import { error, success } from '../../utils/responseHelper.js';

const router = express.Router();

router.use((req, res, next) => {
  const role = String(req.user?.rawRole || req.user?.role || '').toUpperCase();
  if (role !== 'SUPER_ADMIN') {
    return error(res, 'Super admin access required', 403, { safe: true });
  }
  return next();
});

router.get('/overview', async (_req, res) => {
  try {
    const data = await getDatabaseOverview();
    success(res, data, 'Database overview');
  } catch (err) {
    logger.error('Database overview error:', err);
    error(res, 'Failed to load database overview', 500, { safe: true });
  }
});

router.get('/tables/:tableName', async (req, res) => {
  try {
    const data = await getTableDetail(req.params.tableName);
    success(res, data, 'Table detail');
  } catch (err) {
    logger.error('Database table detail error:', err);
    error(res, err.message || 'Failed to load table detail', err.statusCode || 500, { safe: true });
  }
});

router.get('/tables/:tableName/rows', async (req, res) => {
  try {
    const data = await getTableRows(req.params.tableName, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    success(res, data, 'Table rows');
  } catch (err) {
    logger.error('Database table rows error:', err);
    error(res, err.message || 'Failed to load table rows', err.statusCode || 500, { safe: true });
  }
});

export default router;
