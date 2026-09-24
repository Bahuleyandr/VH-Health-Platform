import ApplicationError from "@/app/error";
import GlobalError from "@/app/global-error";
import * as Sentry from "@sentry/nextjs";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));

const captureException = Sentry.captureException as jest.Mock;

describe("application error boundaries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reports an application error without its original detail and preserves retry", () => {
    const privateDetail = "patient-record-secret-sentinel";
    const reset = jest.fn();

    render(<ApplicationError error={new Error(privateDetail)} reset={reset} />);

    expect(document.body).not.toHaveTextContent(privateDetail);
    expect(captureException).toHaveBeenCalledTimes(1);
    const reported = captureException.mock.calls[0][0] as Error;
    expect(reported.message).toBe("Application render failed");
    expect(reported.stack).not.toContain(privateDetail);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("reports a global error without its original detail and preserves retry", () => {
    const privateDetail = "patient-record-secret-sentinel";
    const reset = jest.fn();

    render(<GlobalError error={new Error(privateDetail)} reset={reset} />);

    expect(document.body).not.toHaveTextContent(privateDetail);
    expect(captureException).toHaveBeenCalledTimes(1);
    const reported = captureException.mock.calls[0][0] as Error;
    expect(reported.message).toBe("Global render failed");
    expect(reported.stack).not.toContain(privateDetail);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
