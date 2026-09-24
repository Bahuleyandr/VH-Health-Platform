import { scrubSentryEvent } from "@/lib/sentryScrubber";

describe("Sentry event breadcrumbs", () => {
  it.each([
    "Global render failed",
    "Application render failed",
    "Authenticated page render failed",
    "Dashboard render failed",
    "Idle sign-out backend revocation failed",
  ])("preserves the exact static diagnostic %s", (message) => {
    const scrubbed = scrubSentryEvent({
      message,
      exception: { values: [{ type: "Error", value: message }] },
    });

    expect(scrubbed.message).toBe(message);
    expect(scrubbed.exception.values[0].value).toBe(message);
  });

  it.each([
    "Global render failed for patient Jane Doe",
    "Application render failed ",
    "Authenticated page render failed: VH-12345",
    "Dashboard render failed - jane@example.com",
    "Idle sign-out backend revocation failed: Bearer secret",
    "Unexpected failure",
  ])("filters a non-allowlisted diagnostic: %s", (message) => {
    const scrubbed = scrubSentryEvent({
      message,
      exception: { values: [{ type: "Error", value: message }] },
    });

    expect(scrubbed.message).toBe("[Filtered]");
    expect(scrubbed.exception.values[0].value).toBe("[Filtered]");
  });

  it("drops arbitrary console detail from the outgoing event without mutating the source", () => {
    const privateDetail = "patient-record-secret-sentinel";
    const event = {
      message: "Authenticated page render failed",
      breadcrumbs: [
        {
          category: "console",
          message: privateDetail,
          data: { arguments: [privateDetail] },
        },
      ],
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed).not.toHaveProperty("breadcrumbs");
    expect(JSON.stringify(scrubbed)).not.toContain(privateDetail);
    expect(event.breadcrumbs[0].message).toBe(privateDetail);
  });

  it("removes free-text exception and event messages from automatic captures", () => {
    const privateDetail = "patient-record-secret-sentinel";
    const scrubbed = scrubSentryEvent({
      message: privateDetail,
      exception: {
        values: [
          { type: "Error", value: privateDetail },
          { type: "Cause", value: privateDetail },
        ],
      },
    });

    expect(scrubbed.message).toBe("[Filtered]");
    expect(scrubbed.exception.values).toEqual([
      { type: "Error", value: "[Filtered]" },
      { type: "Cause", value: "[Filtered]" },
    ]);
    expect(JSON.stringify(scrubbed)).not.toContain(privateDetail);
  });

  it("projects only fixed diagnostics and safe event metadata", () => {
    const privateDetail = "Mira Rao";
    const event = {
      event_id: "0123456789abcdef0123456789abcdef",
      timestamp: 1790230000,
      platform: "javascript",
      level: "error",
      message: "Dashboard render failed",
      exception: {
        values: [
          {
            type: "Error",
            value: "Dashboard render failed",
            stacktrace: {
              frames: [
                {
                  filename: `/patients/${privateDetail}`,
                  vars: { patient: privateDetail },
                  context_line: privateDetail,
                },
              ],
            },
            mechanism: { data: { patient: privateDetail } },
          },
        ],
      },
      extra: { serverSignOutError: privateDetail },
      contexts: { nextjs: { request_path: `/patients/${privateDetail}` } },
      tags: { patient: privateDetail },
      request: {
        url: `https://admin.vhhealth.app/patients/${privateDetail}`,
        headers: { "x-patient": privateDetail },
      },
      user: { id: privateDetail },
      transaction: `/patients/${privateDetail}`,
      breadcrumbs: [{ message: privateDetail }],
      sdkProcessingMetadata: { patient: privateDetail },
      unknown: privateDetail,
    };
    const original = JSON.parse(JSON.stringify(event));

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed).toEqual({
      event_id: event.event_id,
      timestamp: event.timestamp,
      platform: "javascript",
      level: "error",
      message: "Dashboard render failed",
      exception: {
        values: [{ type: "Error", value: "Dashboard render failed" }],
      },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(privateDetail);
    expect(event).toEqual(original);
    expect(scrubbed).not.toBe(event);
    expect(scrubbed.exception).not.toBe(event.exception);
  });

  it("rejects near-match paths and untrusted metadata values", () => {
    const privateDetail = "Mira Rao";
    const scrubbed = scrubSentryEvent({
      event_id: privateDetail,
      timestamp: privateDetail,
      platform: privateDetail,
      level: privateDetail,
      message: `Dashboard render failed/${privateDetail}`,
      exception: { values: [{ type: privateDetail, value: privateDetail }] },
    });

    expect(scrubbed).toEqual({
      message: "[Filtered]",
      exception: { values: [{ type: "Error", value: "[Filtered]" }] },
    });
    expect(JSON.stringify(scrubbed)).not.toContain(privateDetail);
  });
});
