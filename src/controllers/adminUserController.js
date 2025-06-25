// src/controllers/adminUserController.js - Hospital Admin User Controller

import { validationResult } from 'express-validator';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import * as userService from '../services/userService.js';
import * as auditService from '../services/userAuditService.js';
import * as analyticsService from '../services/userAnalyticsService.js';
import * as userUtils from '../utils/userUtils.js';
import { USER_ACTIONS } from '../config/userConfig.js';
import logger from '../logging/logger.js';
import { format } from 'date-fns';

/**
 * Get user analytics
 */
export async function getUserAnalytics(req, res) {
  try {
    const { timeframe = '30d', department } = req.query;
    
    const analytics = await analyticsService.getUserAnalytics(timeframe, department);
    
    // Format statistics
    const formattedStats = {
      ...analytics.overallStatistics,
      active_percentage: analytics.overallStatistics.total_users > 0 
        ? ((analytics.overallStatistics.active_users / analytics.overallStatistics.total_users) * 100).toFixed(1)
        : '0.0',
      staff_percentage: analytics.overallStatistics.total_users > 0
        ? ((analytics.overallStatistics.staff_count / analytics.overallStatistics.total_users) * 100).toFixed(1)
        : '0.0',
      avg_tenure_years: (analytics.overallStatistics.avg_tenure_days / 365).toFixed(1)
    };

    const formattedTrends = analytics.registrationTrends.map(trend => ({
      ...trend,
      registration_date_formatted: format(new Date(trend.registration_date), 'dd-MM-yyyy')
    }));

    const formattedActivity = analytics.activityMetrics.map(activity => ({
      ...activity,
      activity_date_formatted: format(new Date(activity.activity_date), 'dd-MM-yyyy'),
      actions_per_user: activity.active_users > 0 
        ? (activity.total_actions / activity.active_users).toFixed(1)
        : '0.0'
    }));

    // Get specialty stats if medical department
    let specialtyStats = [];
    if (!department || department === 'Medical') {
      specialtyStats = await analyticsService.getSpecialtyDistribution();
    }

    success(res, {
      timeframe: analytics.timeframe,
      interval: analytics.interval,
      department: analytics.department,
      overallStatistics: formattedStats,
      roleDistribution: analytics.roleDistribution,
      departmentBreakdown: analytics.departmentBreakdown,
      registrationTrends: formattedTrends,
      activityMetrics: formattedActivity,
      specialtyDistribution: specialtyStats,
      insights: {
        mostActiveRole: analytics.roleDistribution[0]?.role || 'None',
        largestDepartment: analytics.departmentBreakdown[0]?.department || 'None',
        growthRate: formattedTrends.length > 0 
          ? `${formattedTrends.reduce((sum, t) => sum + t.new_registrations, 0)} new users in ${timeframe}`
          : 'No recent growth data',
        activityLevel: formattedStats.active_last_week > 0 
          ? `${((formattedStats.active_last_week / formattedStats.active_users) * 100).toFixed(1)}% of active users were active last week`
          : 'Low activity detected'
      },
      generatedAt: new Date().toISOString(),
      generatedAtFormatted: format(new Date(), 'dd-MM-yyyy HH:mm'),
      requestedBy: req.user?.uid
    }, 'Hospital user analytics generated successfully');

  } catch (err) {
    logger.error('Hospital User Analytics Error:', err);
    error(res, 'Failed to generate hospital user analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Get activity audit
 */
export async function getActivityAudit(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { userId, action, days = 30, ipAddress } = req.query;

    const [activityLogs, activitySummary, suspiciousActivity] = await Promise.all([
      auditService.getActivityAudit({ userId, action, days, ipAddress }),
      auditService.getActivitySummary(days),
      auditService.detectSuspiciousActivity(days)
    ]);

    // Format results
    const formattedLogs = activityLogs.map(log => ({
      ...log,
      created_at_formatted: format(new Date(log.created_at), 'dd-MM-yyyy HH:mm:ss'),
      risk_level: 
        log.action.includes('delete') || log.action.includes('deactivat') ? 'high' :
        log.action.includes('role_change') || log.action.includes('status') ? 'medium' :
        'low'
    }));

    const formattedSummary = activitySummary.map(summary => ({
      ...summary,
      first_occurrence_formatted: format(new Date(summary.first_occurrence), 'dd-MM-yyyy HH:mm'),
      last_occurrence_formatted: format(new Date(summary.last_occurrence), 'dd-MM-yyyy HH:mm'),
      activity_frequency: summary.action_count / days
    }));

    const formattedSuspicious = suspiciousActivity.map(activity => ({
      ...activity,
      first_activity_formatted: format(new Date(activity.first_activity), 'dd-MM-yyyy HH:mm'),
      last_activity_formatted: format(new Date(activity.last_activity), 'dd-MM-yyyy HH:mm'),
      activity_rate: activity.action_count / days,
      risk_score: Math.min(100, (activity.action_count / 10) + (activity.unique_actions * 5))
    }));

    success(res, {
      auditPeriod: `${days} days`,
      filters: { userId, action, ipAddress },
      activityLogs: formattedLogs,
      activitySummary: formattedSummary,
      suspiciousActivity: formattedSuspicious,
      statistics: {
        totalLogs: formattedLogs.length,
        uniqueUsers: new Set(formattedLogs.map(l => l.user_id)).size,
        uniqueIPs: new Set(formattedLogs.map(l => l.ip_address)).size,
        highRiskActions: formattedLogs.filter(l => l.risk_level === 'high').length,
        mostActiveUser: formattedLogs.length > 0 ? formattedLogs[0].user_name : 'None',
        suspiciousActivityCount: formattedSuspicious.length
      },
      securityRecommendations: [
        formattedSuspicious.length > 0 ? 'Review suspicious activity patterns' : null,
        formattedLogs.filter(l => l.risk_level === 'high').length > 10 ? 'High number of high-risk actions detected' : null,
        new Set(formattedLogs.map(l => l.ip_address)).size > 50 ? 'Many unique IP addresses - consider implementing IP restrictions' : null
      ].filter(Boolean),
      auditGenerated: new Date().toISOString(),
      auditGeneratedFormatted: format(new Date(), 'dd-MM-yyyy HH:mm'),
      requestedBy: req.user?.uid
    }, 'Hospital user activity audit completed successfully');

  } catch (err) {
    logger.error('User Activity Audit Error:', err);
    error(res, 'Failed to generate user activity audit', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Get inactive users report
 */
export async function getInactiveUsersReport(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { inactiveDays = 90, role, includePatients = false } = req.query;

    const report = await analyticsService.getInactiveUsersReport(
      parseInt(inactiveDays), 
      role, 
      includePatients === 'true'
    );

    // Format users
    const formattedUsers = report.inactiveUsers.map(user => ({
      ...user,
      registeredAt: format(new Date(user.registered_at), 'dd-MM-yyyy'),
      lastLogin: user.last_login ? format(new Date(user.last_login), 'dd-MM-yyyy HH:mm') : 'Never',
      lastActivity: user.last_activity ? format(new Date(user.last_activity), 'dd-MM-yyyy HH:mm') : 'No activity recorded',
      riskLevel: userUtils.getUserRiskLevel(user.role),
      recommendedAction: userUtils.getInactiveUserRecommendation(user.days_inactive, user.role),
      phone: userUtils.maskPhone(user.phone)
    }));

    success(res, {
      criteria: report.criteria,
      inactiveUsers: formattedUsers,
      departmentBreakdown: report.departmentBreakdown,
      riskAssessment: report.riskAssessment,
      summary: {
        totalInactiveUsers: formattedUsers.length,
        criticalRiskUsers: formattedUsers.filter(u => u.riskLevel === 'CRITICAL').length,
        highRiskUsers: formattedUsers.filter(u => u.riskLevel === 'HIGH').length,
        neverLoggedIn: formattedUsers.filter(u => u.lastLogin === 'Never').length,
        averageInactiveDays: formattedUsers.length > 0 
          ? (formattedUsers.reduce((sum, u) => sum + u.days_inactive, 0) / formattedUsers.length).toFixed(0)
          : 0,
        oldestInactiveUser: formattedUsers.length > 0 
          ? `${formattedUsers[0].name} (${formattedUsers[0].days_inactive} days)`
          : 'None'
      },
      recommendations: [
        formattedUsers.filter(u => u.riskLevel === 'CRITICAL').length > 0 
          ? `${formattedUsers.filter(u => u.riskLevel === 'CRITICAL').length} critical users inactive - immediate action required`
          : null,
        formattedUsers.filter(u => u.days_inactive > 180).length > 0
          ? `${formattedUsers.filter(u => u.days_inactive > 180).length} users inactive for 6+ months - consider deactivation`
          : null,
        formattedUsers.filter(u => u.lastLogin === 'Never').length > 0
          ? `${formattedUsers.filter(u => u.lastLogin === 'Never').length} users have never logged in - review onboarding process`
          : null,
        'Implement automated reminders for inactive users',
        'Review access permissions for long-term inactive accounts'
      ].filter(Boolean),
      reportGenerated: new Date().toISOString(),
      reportGeneratedFormatted: format(new Date(), 'dd-MM-yyyy HH:mm'),
      requestedBy: req.user?.uid
    }, 'Hospital inactive users report generated successfully');

  } catch (err) {
    logger.error('Inactive Users Report Error:', err);
    error(res, 'Failed to generate inactive users report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Reactivate user
 */
export async function reactivateUser(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { userId } = req.params;
    const { reason } = req.body;
    const adminUser = req.user;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const result = await userService.reactivateUser(userId, reason, adminUser);
    const { reactivatedUser, previousStatus, deactivatedPeriod } = result;

    // Log reactivation
    await auditService.logUserAction(
      adminUser.uid,
      USER_ACTIONS.REACTIVATED,
      userId,
      `User reactivated: ${reason}`,
      ipAddress
    );

    logger.info(`🔄 User reactivated: ${reactivatedUser.name} (${reactivatedUser.role}) | Reason: ${reason} | By: ${adminUser.uid}`);

    success(res, {
      reactivatedUser: {
        uid: reactivatedUser.uid,
        name: reactivatedUser.name,
        role: reactivatedUser.role,
        previousStatus,
        newStatus: 'active',
        reactivatedAt: format(new Date(), 'dd-MM-yyyy HH:mm'),
        deactivatedPeriod: deactivatedPeriod ? `${deactivatedPeriod} days` : 'Unknown'
      },
      reactivationDetails: {
        reason,
        reactivatedBy: adminUser.uid,
        reactivatedAt: format(new Date(), 'dd-MM-yyyy HH:mm')
      },
      nextSteps: [
        'User should change password on next login',
        'Review and update user permissions if needed',
        'Verify user still has access to required systems',
        'Update emergency contacts and personal information'
      ],
      requestedBy: adminUser.uid
    }, 'Hospital user reactivated successfully');

  } catch (err) {
    logger.error('Reactivate User Error:', err);
    error(res, err.message || 'Failed to reactivate hospital user', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Generate user report
 */
export async function generateReport(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: RESPONSE_MESSAGES.VALIDATION_FAILED,
      errors: errors.array(),
      requestedBy: req.user?.uid
    });
  }

  try {
    const { reportType, filters = {}, includeInactive = false, dateRange } = req.body;
    const adminUser = req.user;

    const reportData = await analyticsService.generateReport(
      reportType,
      filters,
      { includeInactive, dateRange }
    );

    // Log report generation
    await auditService.logUserAction(
      adminUser.uid,
      USER_ACTIONS.REPORT_GENERATED,
      null,
      `Generated ${reportType} report`,
      req.headers['x-forwarded-for']
    );

    success(res, {
      report: reportData,
      metadata: {
        reportType,
        generatedBy: adminUser.uid,
        generatedAt: new Date().toISOString(),
        generatedAtFormatted: format(new Date(), 'dd-MM-yyyy HH:mm'),
        filters: {
          ...filters,
          includeInactive,
          dateRange
        },
        recordCount: 
          reportData.departments?.length ||
          reportData.roles?.length ||
          reportData.activeUsers?.length ||
          reportData.overallStatistics?.total_users ||
          0
      },
      requestedBy: adminUser.uid
    }, `Hospital ${reportType} report generated successfully`);

  } catch (err) {
    logger.error('Generate User Report Error:', err);
    error(res, err.message || 'Failed to generate hospital user report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * System information
 */
export async function getSystemInfo(req, res) {
  try {
    const { HOSPITAL_ROLES, HOSPITAL_DEPARTMENTS, MEDICAL_SPECIALTIES } = await import('../config/userConfig.js');

    success(res, {
      hospitalRoles: Object.entries(HOSPITAL_ROLES).map(([key, value]) => ({
        role: key,
        ...value
      })),
      departments: HOSPITAL_DEPARTMENTS,
      medicalSpecialties: MEDICAL_SPECIALTIES,
      userManagementFeatures: [
        'Role-based access control',
        'Hospital hierarchy management', 
        'HIPAA compliance tracking',
        'User activity monitoring',
        'Automatic deactivation',
        'Bulk user operations',
        'Comprehensive reporting',
        'Audit trail logging'
      ],
      systemVersion: '2.0.0',
      lastUpdated: '2024-01-15'
    }, 'Hospital user management system information');

  } catch (err) {
    logger.error('System Info Error:', err);
    error(res, 'Failed to fetch system information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}