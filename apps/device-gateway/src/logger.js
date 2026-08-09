// Minimal non-PHI structured logger for the device gateway.
//
// PHI hygiene contract (mirrors the bounded metric labels in metrics.js):
// only the allowlisted fields below are ever emitted — opaque references,
// bounded reason labels, and error codes/names/statuses. HL7 message
// content, patient identifiers, credentials, and free-text error messages
// must never be passed through this logger. Unknown fields are dropped,
// values are truncated, and everything is serialized as one JSON line.

const LEVELS = new Set(['info', 'warn', 'error']);
const ALLOWED_FIELDS = new Set([
  'ack_code',
  'entry_id',
  'error_code',
  'error_name',
  'error_status',
  'listener',
  'partition_ref',
  'port',
  'reason',
  'scope',
  'source_ref',
  'state',
]);

let sink = null;

// Tests (or embedders) can capture log entries instead of writing to the
// process streams. Returns the previous sink so it can be restored.
export function setLogSink(nextSink) {
  const previous = sink;
  sink = nextSink;
  return previous;
}

function sanitizeFields(fields) {
  const out = {};
  for (const key of Object.keys(fields || {}).sort()) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    const value = fields[key];
    if (value === undefined || value === null || value === '') continue;
    out[key] = typeof value === 'number' && Number.isFinite(value)
      ? value
      : String(value).slice(0, 128);
  }
  return out;
}

// Convenience: extract only the safe, bounded parts of an Error.
export function errorFields(err) {
  return {
    error_code: err?.code,
    error_name: err?.name,
    error_status: err?.status,
  };
}

export function logEvent(level, event, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level: LEVELS.has(level) ? level : 'info',
    event: String(event),
    ...sanitizeFields(fields),
  };
  if (sink) {
    sink(entry);
    return entry;
  }
  const line = `${JSON.stringify(entry)}\n`;
  if (entry.level === 'info') process.stdout.write(line);
  else process.stderr.write(line);
  return entry;
}
