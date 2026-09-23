import { scrubSentryEvent } from "@/lib/sentryScrubber";

describe("Sentry event breadcrumbs", () => {
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
});
