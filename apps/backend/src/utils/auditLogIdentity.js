/**
 * audit_log.user_id is an INTEGER FK to users(id). Some authenticated actors
 * only carry a UUID uid, which must not be written into that column.
 */
export function normalizeAuditLogUserId(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  return null;
}
