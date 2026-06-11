// src/logging/phiRedactionFormat.js
//
// Winston format that scrubs phone numbers, emails, and MRN/UHID identifiers
// from every log record — message, stack, and metadata (audit finding H5,
// 2026-06-10). This is the GLOBAL BACKSTOP: services must still mask
// identifiers at the call site via utils/logMasking.js; this format catches
// the call sites everyone forgot.

import { format } from 'winston';
import { scrubPhiDeep, scrubPhiFromString } from '../utils/logMasking.js';

const phiRedactionFormat = format((info) => {
  if (typeof info.message === 'string') {
    info.message = scrubPhiFromString(info.message);
  }
  if (typeof info.stack === 'string') {
    info.stack = scrubPhiFromString(info.stack);
  }
  for (const key of Object.keys(info)) {
    if (key === 'message' || key === 'stack' || key === 'level' || key === 'timestamp') {
      continue;
    }
    try {
      info[key] = scrubPhiDeep(info[key]);
    } catch {
      // Never let redaction break logging — leave the field as-is.
    }
  }
  return info;
});

export default phiRedactionFormat;
