// src/config/responseCodes.js

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500
};

export const RESPONSE_MESSAGES = {
  USER_NOT_FOUND: 'User not found',
  INVALID_PHONE: 'Invalid phone number',
  INVALID_OTP: 'Invalid or expired OTP',
  RECORD_NOT_FOUND: 'Record not found',
  DATABASE_ERROR: 'Database error',
  VALIDATION_FAILED: 'Validation failed',
  LOGIN_SUCCESS: 'Login successful',
  REGISTER_SUCCESS: 'Registration successful',
  OTP_VERIFIED: 'OTP verified successfully',
  FEEDBACK_SUBMITTED: 'Feedback submitted successfully',
  APPOINTMENT_BOOKED: 'Appointment booked successfully',
  ORDER_PLACED: 'Order placed successfully',
  INVESTIGATION_REQUESTED: 'Investigation requested successfully',
  HEALTH_RECORD_ADDED: 'Health record added successfully',
  SOS_ALERT_SAVED: 'SOS alert saved successfully'
};
