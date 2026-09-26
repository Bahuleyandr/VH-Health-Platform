import DashboardError from "@/app/(with-auth)/dashboard/error";
import * as Sentry from "@sentry/nextjs";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));

const captureException = Sentry.captureException as jest.Mock;

describe("Dashboard error boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("hides the original error, reports a generic incident, and keeps retry wired", () => {
    const privateDetail = "patient-record-secret-sentinel";
    const original = new Error(privateDetail);
    const reset = jest.fn();

    const { container } = render(
      <DashboardError error={original} reset={reset} />,
    );

    expect(container).not.toHaveTextContent(privateDetail);
    expect(screen.getByText("This page failed to load.")).toBeInTheDocument();
    expect(captureException).toHaveBeenCalledTimes(1);
    const reported = captureException.mock.calls[0][0] as Error;
    expect(reported).toBeInstanceOf(Error);
    expect(reported).not.toBe(original);
    expect(reported.message).toBe("Dashboard render failed");
    expect(reported.stack).not.toContain(privateDetail);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
