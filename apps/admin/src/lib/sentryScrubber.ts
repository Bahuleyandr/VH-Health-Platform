const REDACTED = "[Filtered]";

const sensitiveKeyPattern =
  /(password|passcode|pin|otp|token|secret|authorization|auth|cookie|api[-_ ]?key|phone|mobile|email|name|address|patient|diagnosis|symptom|note|clinical|medical|record|abha|aadhaar|mrn|hospital[-_ ]?id)/i;

const textPatterns: Array<[RegExp, string]> = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]"],
  [
    /(^|[^\d])(?:\+?91[-\s]?)?\d[\d\s-]{8,12}\d(?=$|[^\d])/g,
    "$1[REDACTED_PHONE]",
  ],
  [/\bVH-\d{4,}\b/gi, "[REDACTED_HOSPITAL_ID]"],
  [
    /\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    "[REDACTED_JWT]",
  ],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    "[REDACTED_UUID]",
  ],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function scrubSentryText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return textPatterns.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

export function normalizeSentryPath(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  let path = value;
  try {
    path = new URL(value).pathname || value;
  } catch {
    [path] = value.split("?");
  }
  const normalized = path
    .replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi,
      "/:uuid",
    )
    .replace(/\/VH-\d{4,}(?=\/|$)/gi, "/:hospitalId")
    .replace(/\/\d{4,}(?=\/|$)/g, "/:id");
  return scrubSentryText(normalized);
}

function scrubValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (key && sensitiveKeyPattern.test(key)) return REDACTED;
  if (typeof value === "string") return scrubSentryText(value);
  if (Array.isArray(value))
    return value.map((item) => scrubValue(item, "", depth + 1));
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      scrubValue(childValue, childKey, depth + 1),
    ]),
  );
}

export function scrubSentryEvent<T>(event: T): T {
  if (!isRecord(event)) return event;
  const originalRequest = isRecord(event.request) ? event.request : undefined;
  const originalTransaction =
    typeof event.transaction === "string" ? event.transaction : undefined;
  const scrubbed = scrubValue(event) as Record<string, unknown>;

  if (isRecord(scrubbed.request)) {
    const request = scrubbed.request;
    scrubbed.request = {
      method: request.method,
      url: normalizeSentryPath(originalRequest?.url ?? request.url),
      headers: scrubValue(request.headers),
    };
  }

  if (typeof scrubbed.transaction === "string") {
    scrubbed.transaction = normalizeSentryPath(
      originalTransaction ?? scrubbed.transaction,
    );
  }

  if (isRecord(scrubbed.user)) {
    scrubbed.user = {
      id: scrubSentryText(scrubbed.user.id),
      role: scrubbed.user.role,
    };
  }

  return scrubbed as T;
}
