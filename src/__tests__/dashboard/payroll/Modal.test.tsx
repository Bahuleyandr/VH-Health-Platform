/**
 * Tests for src/app/(with-auth)/dashboard/payroll/components/Modal.tsx
 *
 * The shared Modal shell used by every payroll tab + RevisionFormModal +
 * RevisionSignModal. Small surface — render-gate on `open`, title rendering,
 * close-button wiring, custom `maxW` propagation.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "@/app/(with-auth)/dashboard/payroll/components/Modal";

describe("<Modal />", () => {
  it("renders nothing when open={false} — never leaks content to the DOM", () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}} title="Hidden">
        <p>body</p>
      </Modal>,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
    expect(screen.queryByText("body")).not.toBeInTheDocument();
  });

  it("renders title + children when open", () => {
    render(
      <Modal open={true} onClose={() => {}} title="Payroll Run">
        <p>body content</p>
      </Modal>,
    );
    expect(screen.getByText("Payroll Run")).toBeInTheDocument();
    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("close button (✕) invokes onClose callback", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(
      <Modal open={true} onClose={onClose} title="X">
        <p>x</p>
      </Modal>,
    );
    await user.click(screen.getByRole("button", { name: "✕" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("default maxW is applied (max-w-xl)", () => {
    const { container } = render(
      <Modal open={true} onClose={() => {}} title="X">
        <p>x</p>
      </Modal>,
    );
    // The second-level div holds the panel with maxW class.
    const panel = container.querySelector(".max-w-xl");
    expect(panel).toBeInTheDocument();
  });

  it("custom maxW prop overrides the default", () => {
    const { container } = render(
      <Modal open={true} onClose={() => {}} title="X" maxW="max-w-5xl">
        <p>x</p>
      </Modal>,
    );
    expect(container.querySelector(".max-w-5xl")).toBeInTheDocument();
    expect(container.querySelector(".max-w-xl")).not.toBeInTheDocument();
  });
});
