import * as Sentry from "@sentry/nextjs";
import { register } from "../../../instrumentation-client";

jest.mock("@sentry/nextjs", () => ({
  init: jest.fn(),
  replayIntegration: jest.fn(() => ({ name: "Replay" })),
  captureRouterTransitionStart: jest.fn(),
}));

describe("client Sentry breadcrumb policy", () => {
  it("registers a callback that drops console breadcrumbs", () => {
    const previousRuntime = process.env.NEXT_RUNTIME;
    jest.clearAllMocks();

    try {
      delete process.env.NEXT_RUNTIME;
      register();

      const init = Sentry.init as jest.Mock;
      expect(init).toHaveBeenCalledTimes(1);
      const config = init.mock.calls[0][0];
      expect(
        config.beforeBreadcrumb({
          category: "console",
          message: "patient-record-secret-sentinel",
        }),
      ).toBeNull();
    } finally {
      if (previousRuntime === undefined) {
        delete process.env.NEXT_RUNTIME;
      } else {
        process.env.NEXT_RUNTIME = previousRuntime;
      }
    }
  });

  it("keeps tracing and Replay disabled despite environment overrides", async () => {
    const previousRuntime = process.env.NEXT_RUNTIME;
    const previousTraces = process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE;
    const previousReplaySession =
      process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE;
    const previousReplayError =
      process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE;

    try {
      process.env.NEXT_RUNTIME = "edge";
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE = "1";
      process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE = "1";
      process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE = "1";
      await jest.isolateModulesAsync(async () => {
        const isolatedSentry = await import("@sentry/nextjs");
        await import("../../../instrumentation-client");
        const config = (isolatedSentry.init as jest.Mock).mock.calls[0][0];

        expect(config.tracesSampleRate).toBe(0);
        expect(config.tracesSampler({ parentSampled: true })).toBe(0);
        expect(config.traceLifecycle).toBe("static");
        expect(config.replaysSessionSampleRate).toBe(0);
        expect(config.replaysOnErrorSampleRate).toBe(0);
        expect(
          config.integrations([
            { name: "Replay" },
            { name: "SpanStreaming" },
            { name: "GlobalHandlers" },
          ]),
        ).toEqual([{ name: "GlobalHandlers" }]);
        expect(isolatedSentry.replayIntegration).not.toHaveBeenCalled();
        expect(
          config.beforeSendTransaction({ transaction: "/patients/Mira Rao" }),
        ).toBeNull();
        expect(
          config.beforeSend({
            message: "Mira Rao",
            extra: { patient: "Mira Rao" },
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
      if (previousReplaySession === undefined)
        delete process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE;
      else
        process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE =
          previousReplaySession;
      if (previousReplayError === undefined)
        delete process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE;
      else
        process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE =
          previousReplayError;
    }
  });
});
