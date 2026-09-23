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
});
