// src/config/notification/notificationConfig.js

export const NOTIFICATION_TYPES = {
  APPOINTMENT: 'APPOINTMENT',
  MEDICATION: 'MEDICATION',
  EMERGENCY: 'EMERGENCY',
  SYSTEM: 'SYSTEM',
  REMINDER: 'REMINDER',
  ALERT: 'ALERT',
  INFO: 'INFO',
  ANNOUNCEMENT: 'ANNOUNCEMENT'
};

export const NOTIFICATION_PRIORITIES = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
};

// Add this new export
export const NOTIFICATION_CHANNELS = {
  IN_APP: 'IN_APP',
  PUSH: 'PUSH',
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  WHATSAPP: 'WHATSAPP'
};

export const NOTIFICATION_LIMITS = {
  MAX_BULK_RECIPIENTS: 100,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  TITLE_MIN_LENGTH: 1,
  TITLE_MAX_LENGTH: 200,
  MESSAGE_MIN_LENGTH: 1,
  MESSAGE_MAX_LENGTH: 1000,
  MAX_QUERY_DAYS: 365,
  DEFAULT_CLEANUP_DAYS: 90
};

export const DEFAULT_TEMPLATES = [
  {
    id: 1,
    name: 'Appointment Reminder',
    title_template: 'Appointment Reminder: {{appointment_date}}',
    message_template: 'Dear {{patient_name}}, you have an appointment with {{doctor_name}} on {{appointment_date}} at {{appointment_time}}.',
    type: NOTIFICATION_TYPES.APPOINTMENT,
    priority: NOTIFICATION_PRIORITIES.MEDIUM,
    variables: ['patient_name', 'doctor_name', 'appointment_date', 'appointment_time']
  },
  {
    id: 2,
    name: 'Emergency Alert',
    title_template: 'EMERGENCY: {{alert_type}}',
    message_template: 'Emergency situation reported: {{alert_details}}. Please respond immediately.',
    type: NOTIFICATION_TYPES.EMERGENCY,
    priority: NOTIFICATION_PRIORITIES.HIGH,
    variables: ['alert_type', 'alert_details']
  },
  {
    id: 3,
    name: 'System Maintenance',
    title_template: 'Scheduled Maintenance: {{maintenance_date}}',
    message_template: 'System maintenance is scheduled for {{maintenance_date}} from {{start_time}} to {{end_time}}. Services may be temporarily unavailable.',
    type: NOTIFICATION_TYPES.SYSTEM,
    priority: NOTIFICATION_PRIORITIES.MEDIUM,
    variables: ['maintenance_date', 'start_time', 'end_time']
  }
];

export const VALID_OPERATIONS = {
  MARK_READ: 'mark_read',
  MARK_UNREAD: 'mark_unread',
  DELETE: 'delete',
  UPDATE_PRIORITY: 'update_priority'
};

// Optional: Add channel-specific configurations
export const CHANNEL_CONFIG = {
  [NOTIFICATION_CHANNELS.IN_APP]: {
    enabled: true,
    maxRetries: 0,
    requiresAuth: true
  },
  [NOTIFICATION_CHANNELS.PUSH]: {
    enabled: true,
    maxRetries: 3,
    requiresDeviceToken: true
  },
  [NOTIFICATION_CHANNELS.SMS]: {
    enabled: true,
    maxRetries: 2,
    requiresPhone: true,
    provider: 'twilio'
  },
  [NOTIFICATION_CHANNELS.EMAIL]: {
    enabled: true,
    maxRetries: 3,
    requiresEmail: true,
    provider: 'sendgrid'
  },
  [NOTIFICATION_CHANNELS.WHATSAPP]: {
    enabled: false,
    maxRetries: 2,
    requiresPhone: true,
    provider: 'twilio'
  }
};