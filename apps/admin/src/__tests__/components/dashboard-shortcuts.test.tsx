import { fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette } from "@/components/CommandPalette";
import { KeyboardShortcutsModal } from "@/components/KeyboardShortcutsModal";
import { usePermissions } from "@/hooks/usePermissions";

const push = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("@/hooks/usePermissions", () => ({
  usePermissions: jest.fn(),
}));

const mockedUsePermissions = usePermissions as jest.MockedFunction<
  typeof usePermissions
>;

function setPermissions(hasAllPermissions: (permissions: string[]) => boolean) {
  mockedUsePermissions.mockReturnValue({
    rawRole: "ADMIN",
    role: "ADMIN",
    isSuperAdmin: false,
    hasAllPermissions,
  } as ReturnType<typeof usePermissions>);
}

describe("dashboard keyboard shortcuts", () => {
  beforeEach(() => {
    setPermissions(() => true);
  });

  test("Ctrl+/ opens the command palette and focuses its search", () => {
    render(<CommandPalette />);

    fireEvent.keyDown(document, { key: "/", ctrlKey: true });

    expect(
      screen.getByPlaceholderText("Type a command or search..."),
    ).toHaveFocus();
  });

  test.each([
    ["d", "/dashboard"],
    ["u", "/dashboard/users"],
    ["a", "/dashboard/appointments"],
    ["r", "/dashboard/doctors"],
  ])("G then %s navigates to its authorized destination", (key, href) => {
    render(<CommandPalette />);

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key });

    expect(push).toHaveBeenCalledWith(href);
  });

  test("role-filtered destinations are neither invoked nor advertised", () => {
    setPermissions(() => false);
    const { unmount } = render(<CommandPalette />);

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "u" });
    expect(push).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "d" });
    expect(push).toHaveBeenCalledWith("/dashboard");

    unmount();
    render(<KeyboardShortcutsModal />);
    fireEvent.keyDown(document, { key: "?" });

    expect(screen.getByText("Focus command search")).toBeInTheDocument();
    expect(screen.getByText("Go to Dashboard")).toBeInTheDocument();
    expect(screen.queryByText("Go to Users")).not.toBeInTheDocument();
    expect(screen.queryByText("Go to Appointments")).not.toBeInTheDocument();
    expect(screen.queryByText("Go to Doctors")).not.toBeInTheDocument();
  });

  test("navigation sequences do not steal keystrokes from editable controls", () => {
    render(
      <>
        <input aria-label="Page search" />
        <CommandPalette />
      </>,
    );
    const pageSearch = screen.getByLabelText("Page search");

    fireEvent.keyDown(pageSearch, { key: "g" });
    fireEvent.keyDown(pageSearch, { key: "d" });

    expect(push).not.toHaveBeenCalled();
  });
});
