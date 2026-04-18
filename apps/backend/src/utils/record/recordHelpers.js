// src/utils/record/recordHelpers.js
import { formatDateDDMMYYYY } from '../dateUtils.js';

export function formatDateForDisplay(date) {
  return formatDateDDMMYYYY(date);
}

export function formatDateTimeForDisplay(date) {
  if (!date) {return null;}
  const dateStr = formatDateDDMMYYYY(date);
  const d = new Date(date);
  const timeStr = d.toLocaleTimeString('en-GB', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false 
  });
  return `${dateStr} ${timeStr}`;
}

export function calculateRecordAge(createdAt) {
  const created = new Date(createdAt);
  const now = new Date();
  const diffTime = Math.abs(now - created);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) {return 'Today';}
  if (diffDays === 1) {return 'Yesterday';}
  if (diffDays < 7) {return `${diffDays} days ago`;}
  if (diffDays < 30) {return `${Math.floor(diffDays / 7)} weeks ago`;}
  if (diffDays < 365) {return `${Math.floor(diffDays / 30)} months ago`;}
  return `${Math.floor(diffDays / 365)} years ago`;
}

export function sanitizeRecordData(data) {
  const sanitized = { ...data };
  delete sanitized.deleted_by;
  delete sanitized.internal_notes;
  return sanitized;
}