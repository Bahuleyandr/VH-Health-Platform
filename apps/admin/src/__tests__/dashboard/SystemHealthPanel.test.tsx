import { render, screen } from "@testing-library/react";
import { SystemHealthSection } from "@/app/(with-auth)/dashboard/components/SystemHealthPanel";

describe("SystemHealthSection truthfulness", () => {
  const updated = new Date("2026-08-13T10:00:00.000Z");

  it("renders absent health data as unknown, never healthy", () => {
    render(<SystemHealthSection health={null} lastUpdated={updated} />);

    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
  });

  it.each(["unavailable", "stale"] as const)(
    "renders %s explicitly",
    (status) => {
      render(
        <SystemHealthSection
          health={{ status, detail: `${status} health evidence` }}
          lastUpdated={updated}
        />,
      );

      expect(
        screen.getByText(status === "stale" ? "Stale" : "Unavailable"),
      ).toBeInTheDocument();
      expect(screen.getByText(`${status} health evidence`)).toBeInTheDocument();
    },
  );
});
