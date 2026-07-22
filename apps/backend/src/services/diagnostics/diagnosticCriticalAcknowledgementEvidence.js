const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHORIZATION_MODES = new Set(['assignee', 'role', 'admin', 'override']);

function hasText(value) {
  return String(value || '').trim().length > 0;
}

export function hasValidDiagnosticCriticalAcknowledgementReceipt({
  taskStatus,
  slaCompletedAt,
  taskMetadata,
  assignedToUid,
  assignedToRole,
} = {}) {
  if (!['in_progress', 'completed'].includes(String(taskStatus || '').toLowerCase())) {
    return false;
  }
  if (!slaCompletedAt) return false;
  const acknowledgedAt = new Date(String(taskMetadata?.acknowledged_at || ''));
  if (Number.isNaN(acknowledgedAt.getTime())) return false;
  const acknowledgedBy = String(taskMetadata?.acknowledged_by || '').trim();
  const acknowledgedVia = String(taskMetadata?.acknowledged_via || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(acknowledgedBy) || !AUTHORIZATION_MODES.has(acknowledgedVia)) {
    return false;
  }
  if (acknowledgedVia === 'assignee') {
    return acknowledgedBy.toLowerCase() === String(assignedToUid || '').trim().toLowerCase();
  }
  if (acknowledgedVia === 'role') {
    return hasText(assignedToRole);
  }
  if (acknowledgedVia === 'override') {
    return hasText(taskMetadata?.acknowledge_override_source)
      && hasText(taskMetadata?.acknowledge_override_id)
      && hasText(taskMetadata?.acknowledge_override_reason);
  }
  return true;
}

export default { hasValidDiagnosticCriticalAcknowledgementReceipt };
