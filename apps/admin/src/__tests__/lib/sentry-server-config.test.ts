jest.mock("@sentry/nextjs", () => ({ init: jest.fn() }));

describe("server Sentry privacy configuration", () => {
  it("drops untrusted event fields and disables tracing despite an environment override", async () => {
    const previousRuntime = process.env.NEXT_RUNTIME;
    const previousTraces = process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE;

    try {
      process.env.NEXT_RUNTIME = "nodejs";
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE = "1";
      await jest.isolateModulesAsync(async () => {
        const isolatedSentry = await import("@sentry/nextjs");
        await import("../../../instrumentation-server");
        const config = (isolatedSentry.init as jest.Mock).mock.calls[0][0];

        expect(config.tracesSampleRate).toBe(0);
        expect(config.tracesSampler({ parentSampled: true })).toBe(0);
        expect(config.traceLifecycle).toBe("static");
        expect(
          config.integrations([
            { name: "SpanStreaming" },
            { name: "GlobalHandlers" },
          ]),
        ).toEqual([{ name: "GlobalHandlers" }]);
        expect(
          config.beforeSendTransaction({ transaction: "/patients/Mira Rao" }),
        ).toBeNull();
        expect(
          config.beforeSend({
            message: "Mira Rao",
            contexts: { nextjs: { request_path: "/patients/Mira Rao" } },
          }),
        ).toEqual({
          message: "[Filtered]",
        });
      });
    } finally {
      if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME;
      else process.env.NEXT_RUNTIME = previousRuntime;
      if (previousTraces === undefined)
        delete process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE;
      else process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE = previousTraces;
    }
  });
});
