// src/config/fileUploadConfig.js

export const FILE_UPLOAD_RULES = {
  allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  maxFileSizeBytes: 5 * 1024 * 1024, // 5 MB
  description: 'Only PDF, JPEG, and PNG files up to 5MB are allowed.',
};
