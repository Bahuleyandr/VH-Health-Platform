// src/utils/notification/notificationHelpers.js

import { format } from 'date-fns';

/**
 * Format notification date to DD-MM-YYYY format
 * @param {Date|string} date - Date to format
 * @returns {string} Formatted date string
 */
export const formatNotificationDate = (date) => {
  if (!date) return null;
  return format(new Date(date), 'dd-MM-yyyy');
};

/**
 * Format notification time to HH:mm format
 * @param {Date|string} date - Date to format
 * @returns {string} Formatted time string
 */
export const formatNotificationTime = (date) => {
  if (!date) return null;
  return format(new Date(date), 'HH:mm');
};

/**
 * Check if user has access to notification
 * @param {Object} user - User object from req.user
 * @param {number} targetUserId - Target user ID for the notification
 * @param {number} userDbId - User's database ID
 * @returns {boolean} Whether user has access
 */
export const hasNotificationAccess = (user, targetUserId, userDbId) => {
  const userRole = user?.role?.toUpperCase();
  
  // Admins and medical staff have access to all notifications
  if (['ADMIN', 'DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
    return true;
  }
  
  // Patients can only access their own notifications
  if (userRole === 'PATIENT') {
    return userDbId === targetUserId;
  }
  
  return false;
};

/**
 * Build notification filter query
 * @param {Object} filters - Filter parameters
 * @returns {Object} Query string and parameters
 */
export const buildNotificationQuery = (filters) => {
  const { type, priority, read_status, user_role, date_from, date_to, search } = filters;
  let query = '';
  let params = [];
  let conditions = [];
  
  if (type) {
    conditions.push(`n.type = $${params.length + 1}`);
    params.push(type.toUpperCase());
  }
  
  if (priority) {
    conditions.push(`n.priority = $${params.length + 1}`);
    params.push(priority.toUpperCase());
  }
  
  if (read_status === 'read') {
    conditions.push('n.is_read = true');
  } else if (read_status === 'unread') {
    conditions.push('n.is_read = false');
  }
  
  if (user_role) {
    conditions.push(`u.role = $${params.length + 1}`);
    params.push(user_role.toUpperCase());
  }
  
  if (date_from) {
    conditions.push(`DATE(n.created_at) >= $${params.length + 1}`);
    params.push(date_from);
  }
  
  if (date_to) {
    conditions.push(`DATE(n.created_at) <= $${params.length + 1}`);
    params.push(date_to);
  }
  
  if (search) {
    conditions.push(`(n.title ILIKE $${params.length + 1} OR n.message ILIKE $${params.length + 1} OR u.name ILIKE $${params.length + 1})`);
    params.push(`%${search}%`);
  }
  
  if (conditions.length > 0) {
    query = ' AND ' + conditions.join(' AND ');
  }
  
  return { query, params };
};

/**
 * Replace template variables with values
 * @param {string} template - Template string with {{variables}}
 * @param {Object} values - Key-value pairs for replacement
 * @returns {string} Processed string
 */
export const processTemplate = (template, values) => {
  let processed = template;
  
  Object.entries(values).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    processed = processed.replace(regex, value);
  });
  
  return processed;
};

/**
 * Build user targeting query for notifications
 * @param {Object} criteria - Targeting criteria
 * @returns {Object} Query string and parameters
 */
export const buildUserTargetingQuery = (criteria) => {
  let query = 'SELECT DISTINCT u.id, u.name, u.phone FROM users u';
  let joins = [];
  let conditions = [];
  let params = [];
  
  if (criteria.role) {
    conditions.push(`u.role = $${params.length + 1}`);
    params.push(criteria.role.toUpperCase());
  }
  
  if (criteria.department) {
    joins.push('LEFT JOIN doctors d ON u.id = d.user_id');
    joins.push('LEFT JOIN staff s ON u.id = s.user_id');
    conditions.push(`(d.department = $${params.length + 1} OR s.department = $${params.length + 1})`);
    params.push(criteria.department);
  }
  
  if (criteria.registration_after) {
    conditions.push(`u.registered_at >= $${params.length + 1}`);
    params.push(criteria.registration_after);
  }
  
  if (criteria.has_appointments_in_last_days) {
    joins.push('LEFT JOIN appointments a ON (u.id = a.patient_id OR u.id = a.doctor_id)');
    conditions.push(`a.appointment_date >= CURRENT_DATE - INTERVAL '${criteria.has_appointments_in_last_days} days'`);
  }
  
  if (joins.length > 0) {
    query += ' ' + joins.join(' ');
  }
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  return { query, params };
};

/**
 * Format notification for response
 * @param {Object} notification - Raw notification from database
 * @param {boolean} includePrivateData - Whether to include private data
 * @returns {Object} Formatted notification
 */
export const formatNotificationResponse = (notification, includePrivateData = false) => {
  const formatted = {
    id: notification.id,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    priority: notification.priority,
    is_read: notification.is_read,
    created_at: notification.created_at,
    created_date: formatNotificationDate(notification.created_at),
    created_time: formatNotificationTime(notification.created_at)
  };
  
  if (notification.read_at) {
    formatted.read_at = notification.read_at;
    formatted.read_date = formatNotificationDate(notification.read_at);
    formatted.read_time = formatNotificationTime(notification.read_at);
  }
  
  if (notification.scheduled_for) {
    formatted.scheduled_for = notification.scheduled_for;
    formatted.scheduled_date = formatNotificationDate(notification.scheduled_for);
    formatted.scheduled_time = formatNotificationTime(notification.scheduled_for);
  }
  
  if (includePrivateData) {
    formatted.user_id = notification.user_id;
    formatted.sender_id = notification.sender_id;
    formatted.phone = notification.phone;
    formatted.data = notification.data;
    
    if (notification.recipient_name) {
      formatted.recipient_name = notification.recipient_name;
    }
    if (notification.recipient_phone) {
      formatted.recipient_phone = notification.recipient_phone;
    }
    if (notification.sender_name) {
      formatted.sender_name = notification.sender_name;
    }
  }
  
  return formatted;
};