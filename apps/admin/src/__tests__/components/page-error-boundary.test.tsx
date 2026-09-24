import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import * as Sentry from "@sentry/nextjs";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));

const captureException = Sentry.captureException as jest.Mock;

describe("PageErrorBoundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps render-error details out of the page and telemetry", () => {
    const privateDetail = "patient-record-secret-sentinel";
    let shouldThrow = true;
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    function Child() {
      if (shouldThrow) throw new Error(privateDetail);
      return <span>Recovered</span>;
    }

    try {
      const { container } = render(
        <PageErrorBoundary>
          <Child />
        </PageErrorBoundary>,
      );

      expect(container).not.toHaveTextContent(privateDetail);
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      expect(captureException).toHaveBeenCalledTimes(1);
      const reported = captureException.mock.calls[0][0] as Error;
      expect(reported).toBeInstanceOf(Error);
      expect(reported.message).toBe("Authenticated page render failed");
      expect(reported.stack).not.toContain(privateDetail);

      shouldThrow = false;
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(screen.getByText("Recovered")).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});
