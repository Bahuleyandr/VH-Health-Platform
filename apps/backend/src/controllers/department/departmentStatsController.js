// src/controllers/department/departmentStatsController.js
import { DEPARTMENT_MESSAGES } from '../../config/departmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import departmentStatsService from '../../services/department/departmentStatsService.js';
import { success, error } from '../../utils/responseHelper.js';

export const getDepartmentStats = async (req, res) => {
  try {
    const { id } = req.params;
    const stats = await departmentStatsService.getDepartmentStats(id);
    
    if (!stats) {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    success(res, {
      ...stats,
      requestedBy: req.user?.name
    }, DEPARTMENT_MESSAGES.STATS_RETRIEVED);
  } catch (err) {
    logger.error('Error in getDepartmentStats:', err);
    error(res, 'Failed to retrieve department statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getDepartmentPerformance = async (req, res) => {
  try {
    const { id } = req.params;
    const { days = 30 } = req.query;
    
    const performance = await departmentStatsService.getDepartmentPerformanceMetrics(
      id, 
      parseInt(days)
    );
    
    // Get department name for response
    const basicStats = await departmentStatsService.getDepartmentStats(id);
    
    success(res, {
      department: basicStats?.department || `Department ${id}`,
      performance_metrics: performance,
      period_days: parseInt(days),
      requestedBy: req.user?.name
    }, 'Department performance metrics retrieved successfully');
  } catch (err) {
    logger.error('Error in getDepartmentPerformance:', err);
    
    if (err.message === 'Department not found') {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to retrieve department performance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getDepartmentTrends = async (req, res) => {
  try {
    const { id } = req.params;
    const { months = 6 } = req.query;
    
    const trends = await departmentStatsService.getDepartmentTrends(
      id, 
      parseInt(months)
    );
    
    // Get department name for response
    const basicStats = await departmentStatsService.getDepartmentStats(id);
    
    success(res, {
      department: basicStats?.department || `Department ${id}`,
      trends,
      period_months: parseInt(months),
      requestedBy: req.user?.name
    }, 'Department trends retrieved successfully');
  } catch (err) {
    logger.error('Error in getDepartmentTrends:', err);
    
    if (err.message === 'Department not found') {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to retrieve department trends', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getDepartmentComparison = async (req, res) => {
  try {
    const comparison = await departmentStatsService.getDepartmentComparisonStats();
    
    success(res, {
      departments: comparison,
      count: comparison.length,
      period: 'Last 30 days',
      requestedBy: req.user?.name
    }, 'Department comparison retrieved successfully');
  } catch (err) {
    logger.error('Error in getDepartmentComparison:', err);
    error(res, 'Failed to retrieve department comparison', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getDepartmentAnalytics = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get comprehensive analytics
    const [basicStats, trends, performance] = await Promise.all([
      departmentStatsService.getDepartmentStats(id),
      departmentStatsService.getDepartmentTrends(id, 6),
      departmentStatsService.getDepartmentPerformanceMetrics(id, 30)
    ]);
    
    if (!basicStats) {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    success(res, {
      department: basicStats.department,
      statistics: basicStats.statistics,
      trends: trends,
      recent_performance: performance,
      requestedBy: req.user?.name
    }, 'Department analytics retrieved successfully');
  } catch (err) {
    logger.error('Error in getDepartmentAnalytics:', err);
    error(res, 'Failed to retrieve department analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};