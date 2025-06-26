// src/utils/record/recordHelpers.js
export function formatDateForDisplay(date) {
  if (!date) return null;
  return new Date(date).toLocaleDateString('en-GB');
}

export function formatDateTimeForDisplay(date) {
  if (!date) return null;
  const d = new Date(date);
  return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { 
    hour: '2-digit', 
    minute: '2-digit' 
  });
}

export function calculateRecordAge(createdAt) {
  const created = new Date(createdAt);
  const now = new Date();
  const diffTime = Math.abs(now - created);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} years ago`;
}

export function sanitizeRecordData(data) {
  // Remove any potentially sensitive fields that shouldn't be exposed
  const sanitized = { ...data };
  delete sanitized.deleted_by;
  delete sanitized.internal_notes;
  return sanitized;
}