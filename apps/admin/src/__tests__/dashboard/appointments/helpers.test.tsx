/**
 * Tests for src/app/(with-auth)/dashboard/appointments/components/helpers.tsx
 *
 * Pins the pure-function helpers extracted during the appointments god-page
 * refactor (1057→82 LOC, commit 02fac27). The `normalizeAppointmentsResponse`
 * helper is especially safety-critical — it's the single funnel that handles
 * backend shape variance (raw array vs `{appointments: []}` vs `{data: []}`
 * vs malformed), and a regression here silently blanks the entire
 * AllAppointmentsTab.
 */

import {
  isObj,
  normalizeAppointmentsResponse,
  fmtDate,
  fmtDateTime,
  StatusBadge,
} from "@/app/(with-auth)/dashboard/appointments/components/helpers";
import { render, screen } from "@testing-library/react";

describe("isObj type guard", () => {
  it("true for plain objects", () => {
    expect(isObj({})).toBe(true);
    expect(isObj({ a: 1 })).toBe(true);
  });

  it("false for null (the historical off-by-one bug)", () => {
    expect(isObj(null)).toBe(false);
  });

  it("false for primitives + arrays", () => {
    expect(isObj("str")).toBe(false);
    expect(isObj(42)).toBe(false);
    expect(isObj(undefined)).toBe(false);
    // Arrays are `typeof === 'object'` — caller must check separately.
    // isObj returns true for arrays per its signature; consumers (like
    // normalizeAppointmentsResponse) call Array.isArray BEFORE isObj.
    expect(isObj([])).toBe(true);
  });
});

describe("normalizeAppointmentsResponse", () => {
  it("unwraps a bare array → page 1, limit 10, total=length", () => {
    const raw = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const out = normalizeAppointmentsResponse(raw, 1);
    expect(out.appointments).toHaveLength(3);
    expect(out.pagination).toEqual({
      page: 1,
      limit: 10,
      total: 3,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    });
  });

  it("pulls from envelope `{ appointments: [...], total: N }`", () => {
    const raw = {
      appointments: [{ id: 100 }, { id: 101 }],
      total: 47,
    };
    const out = normalizeAppointmentsResponse(raw, 2);
    expect(out.appointments).toHaveLength(2);
    expect(out.pagination.page).toBe(2);
    expect(out.pagination.total).toBe(47);
    // page 2 of 10 → totalPages = ceil(47/10) = 5
    expect(out.pagination.totalPages).toBe(5);
    // page 2 * 10 = 20 < 47 → hasNext
    expect(out.pagination.hasNext).toBe(true);
    expect(out.pagination.hasPrev).toBe(true);
  });

  it("falls back to envelope `{ data: [...] }` when no `appointments` key", () => {
    const raw = { data: [{ id: 7 }] };
    const out = normalizeAppointmentsResponse(raw, 1);
    expect(out.appointments).toHaveLength(1);
    expect(out.appointments[0]).toEqual({ id: 7 });
  });

  it("uses length as total when `total` field is missing", () => {
    const raw = { appointments: [{ id: 1 }, { id: 2 }] };
    const out = normalizeAppointmentsResponse(raw, 1);
    expect(out.pagination.total).toBe(2);
  });

  it("returns an empty safe shape for null / primitive / garbage input", () => {
    for (const garbage of [null, undefined, "oops", 42, true]) {
      const out = normalizeAppointmentsResponse(garbage as unknown, 1);
      expect(out.appointments).toEqual([]);
      expect(out.pagination.total).toBe(0);
      expect(out.pagination.totalPages).toBe(1);
      expect(out.pagination.hasNext).toBe(false);
    }
  });

  it("hasPrev is true iff the current page is >1, regardless of shape", () => {
    const out = normalizeAppointmentsResponse([], 3);
    expect(out.pagination.hasPrev).toBe(true);
    const out1 = normalizeAppointmentsResponse([], 1);
    expect(out1.pagination.hasPrev).toBe(false);
  });
});

describe("fmtDate / fmtDateTime", () => {
  it("formats ISO strings in en-IN short form (day-month-year)", () => {
    expect(fmtDate("2026-04-15T00:00:00.000Z")).toMatch(/15 Apr 2026/);
  });

  it("em-dash for null/undefined/empty", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate(undefined)).toBe("—");
    expect(fmtDate("")).toBe("—");
    expect(fmtDateTime(null)).toBe("—");
  });

  it("fmtDateTime renders both date + time components", () => {
    const out = fmtDateTime("2026-04-15T14:30:00.000Z");
    // Day-Month + HH:MM form — exact time depends on local tz so just check both parts present
    expect(out).toMatch(/\d{2} \w+/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("<StatusBadge />", () => {
  it("renders the status text verbatim (no case change)", () => {
    render(<StatusBadge status="SCHEDULED" />);
    expect(screen.getByText("SCHEDULED")).toBeInTheDocument();
  });

  it("maps known statuses to expected colour classes", () => {
    const cases: Array<[string, RegExp]> = [
      ["SCHEDULED", /bg-orange-100/],
      ["CONFIRMED", /bg-teal-100/],
      ["COMPLETED", /bg-green-100/],
      ["CANCELLED", /bg-red-100/],
      ["NO_SHOW", /bg-gray-100/],
    ];
    for (const [status, className] of cases) {
      const { container } = render(<StatusBadge status={status} />);
      expect(container.querySelector("span")!.className).toMatch(className);
    }
  });

  it("unknown status falls back to neutral blue (no undefined class)", () => {
    const { container } = render(<StatusBadge status="MYSTERY" />);
    const el = container.querySelector("span")!;
    expect(el.className).toMatch(/bg-blue-100/);
    expect(el.className).not.toMatch(/undefined/);
  });
});
