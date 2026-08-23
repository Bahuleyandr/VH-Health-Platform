/**
 * Tests for src/app/(with-auth)/dashboard/payroll/components/helpers.tsx
 *
 * Pins the pure-function helpers extracted during the payroll god-page
 * refactor (1603→62 LOC, commit 651d079). These are the shared primitives
 * every payroll tab depends on — a regression here breaks formatting on
 * five screens at once.
 */

import {
  unwrap,
  MONTHS,
  fmtMonth,
  fmtCurrency,
  fmtDate,
  statusBadge,
} from "@/app/(with-auth)/dashboard/payroll/components/helpers";
import { render, screen } from "@testing-library/react";

describe("unwrap", () => {
  it("returns the value untouched when there's no `data` key", () => {
    expect(unwrap<number[]>([1, 2, 3])).toEqual([1, 2, 3]);
    expect(unwrap<string>("raw")).toBe("raw");
    expect(unwrap<null>(null)).toBe(null);
  });

  it("peels one layer when the value is shaped { data: ... }", () => {
    expect(unwrap<number[]>({ data: [10, 20] })).toEqual([10, 20]);
    const inner = { id: 42, name: "run" };
    expect(unwrap<typeof inner>({ data: inner })).toBe(inner);
  });

  it("does NOT double-unwrap — only peels the outermost layer", () => {
    const nested = { data: { data: "deep" } };
    expect(unwrap<{ data: string }>(nested)).toEqual({ data: "deep" });
  });
});

describe("fmtMonth", () => {
  it("returns the short English month name for 1..12", () => {
    expect(fmtMonth(1)).toBe("Jan");
    expect(fmtMonth(6)).toBe("Jun");
    expect(fmtMonth(12)).toBe("Dec");
  });

  it("wraps around via modulo arithmetic", () => {
    // fmtMonth(13) → (13-1+12) % 12 = 0 → Jan
    expect(fmtMonth(13)).toBe("Jan");
    // fmtMonth(0)  → (0-1+12) % 12 = 11 → Dec
    expect(fmtMonth(0)).toBe("Dec");
  });

  it("MONTHS array has exactly 12 entries (regression guard)", () => {
    expect(MONTHS).toHaveLength(12);
    expect(MONTHS[0]).toBe("Jan");
    expect(MONTHS[11]).toBe("Dec");
  });
});

describe("fmtCurrency", () => {
  it("formats numeric strings with Indian grouping + 2 decimals + ₹ prefix", () => {
    expect(fmtCurrency("50000")).toBe("₹50,000.00");
    expect(fmtCurrency("100000")).toBe("₹1,00,000.00");
    expect(fmtCurrency("12345678.9")).toBe("₹1,23,45,678.90");
  });

  it("accepts number inputs", () => {
    expect(fmtCurrency(0)).toBe("₹0.00");
    expect(fmtCurrency(999.5)).toBe("₹999.50");
  });

  it("treats null / undefined / empty as zero (no NaN leak)", () => {
    expect(fmtCurrency(null)).toBe("₹0.00");
    expect(fmtCurrency(undefined)).toBe("₹0.00");
    expect(fmtCurrency("")).toBe("₹0.00");
  });
});

describe("fmtDate", () => {
  it("formats ISO strings in en-IN short form", () => {
    // 2026-04-15 → "15 Apr 2026"
    expect(fmtDate("2026-04-15T00:00:00.000Z")).toMatch(/^15 Apr 2026$/);
  });

  it("returns em-dash for null/undefined/empty (never invalid date)", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate(undefined)).toBe("—");
    expect(fmtDate("")).toBe("—");
  });
});

describe("statusBadge", () => {
  it("renders a capitalized chip with the status text", () => {
    render(<>{statusBadge("approved")}</>);
    expect(screen.getByText("approved")).toBeInTheDocument();
  });

  it("substitutes underscores with spaces (pending_hr → 'pending hr')", () => {
    render(<>{statusBadge("pending_hr")}</>);
    expect(screen.getByText("pending hr")).toBeInTheDocument();
  });

  it("falls back to neutral grey colour for unknown status (no crash)", () => {
    const { container } = render(<>{statusBadge("mystery_status")}</>);
    const el = container.querySelector("span")!;
    expect(el).toBeInTheDocument();
    expect(el.className).toMatch(/bg-gray-100/);
  });

  it("green for approved / issued / completed (positive-state consistency)", () => {
    for (const s of ["approved", "issued", "completed"]) {
      const { container } = render(<>{statusBadge(s)}</>);
      expect(container.querySelector("span")!.className).toMatch(/bg-green-100/);
    }
  });

  it("red for rejected (negative-state consistency)", () => {
    const { container } = render(<>{statusBadge("rejected")}</>);
    expect(container.querySelector("span")!.className).toMatch(/bg-red-100/);
  });

  it("red for completed_with_errors — never green like a clean completed", () => {
    const { container } = render(<>{statusBadge("completed_with_errors")}</>);
    const el = container.querySelector("span")!;
    expect(el.className).toMatch(/bg-red-100/);
    expect(el.className).not.toMatch(/bg-green-100/);
    expect(screen.getByText("completed with errors")).toBeInTheDocument();
  });
});
