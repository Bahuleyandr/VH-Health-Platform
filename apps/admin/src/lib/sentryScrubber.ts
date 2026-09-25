const REDACTED = "[Filtered]";
const safeMessages = new Set([
  "Global render failed",
  "Application render failed",
  "Authenticated page render failed",
  "Dashboard render failed",
  "Idle sign-out backend revocation failed",
]);
const safeLevels = new Set([
  "fatal",
  "error",
  "warning",
  "log",
  "info",
  "debug",
]);

function scrubMessage(value: string): string {
  return safeMessages.has(value) ? value : REDACTED;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function scrubSentryEvent<T>(event: T): T {
  if (!isRecord(event)) return {} as T;

  const projected: Record<string, unknown> = {};
  if (
    typeof event.event_id === "string" &&
    /^[a-f\d]{32}$/i.test(event.event_id)
  ) {
    projected.event_id = event.event_id;
  }
  if (typeof event.timestamp === "number" && Number.isFinite(event.timestamp)) {
    projected.timestamp = event.timestamp;
  }
  if (event.platform === "javascript") projected.platform = "javascript";
  if (typeof event.level === "string" && safeLevels.has(event.level)) {
    projected.level = event.level;
  }
  if (typeof event.message === "string") {
    projected.message = scrubMessage(event.message);
  }

  if (isRecord(event.exception) && Array.isArray(event.exception.values)) {
    projected.exception = {
      values: event.exception.values.filter(isRecord).map((value) => ({
        type: value.type === "Cause" ? "Cause" : "Error",
        value:
          typeof value.value === "string"
            ? scrubMessage(value.value)
            : REDACTED,
      })),
    };
  }

  return projected as T;
}
