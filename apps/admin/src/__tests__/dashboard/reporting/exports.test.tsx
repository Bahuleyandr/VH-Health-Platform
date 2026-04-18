import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DataExporter } from "@/app/(with-auth)/dashboard/reporting/components/DataExporter";
import { ReportGenerator } from "@/app/(with-auth)/dashboard/reporting/components/ReportGenerator";
import type { Doctor, User } from "@/lib/types";

function blobResponse(body: string, type: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": type }),
    blob: jest.fn().mockResolvedValue(new Blob([body], { type })),
  } as unknown as Response;
}

describe("reporting export flows", () => {
  const createObjectURL = jest.fn(() => "blob:test");
  const revokeObjectURL = jest.fn();
  let fetchMock: jest.MockedFunction<typeof fetch>;
  let clickSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      writable: true,
      configurable: true,
    });
    clickSpy = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    clickSpy.mockRestore();
  });

  it("downloads appointment exports through the proxied /api/v1 route with backend query names", async () => {
    fetchMock.mockResolvedValueOnce(blobResponse("id,name\n1,Asha", "text/csv"));

    render(<DataExporter />);

    const card = screen.getByText("Appointments CSV").closest("div");
    if (!card) throw new Error("Appointments export card not found");

    fireEvent.click(within(card).getByRole("button", { name: /download/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/proxy/api/v1/appointments/admin/export?format=csv&date_from=",
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain("&date_to=");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("startDate");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("endDate");
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("routes filtered record exports through the proxied record export endpoint", async () => {
    fetchMock.mockResolvedValueOnce(blobResponse("%PDF-1.4", "application/pdf"));

    render(
      <ReportGenerator
        users={[
          { id: 1, name: "Asha", email: "asha@example.com" } as User,
        ]}
        doctors={[
          { user_id: 99, name: "Mehta", specialization: "Cardiology" } as Doctor,
        ]}
      />,
    );

    fireEvent.change(screen.getByLabelText("Patient"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Doctor"), {
      target: { value: "99" },
    });
    fireEvent.change(screen.getByLabelText("Report Type"), {
      target: { value: "appointments" },
    });
    fireEvent.change(screen.getByLabelText("From Date"), {
      target: { value: "2026-04-01" },
    });
    fireEvent.change(screen.getByLabelText("To Date"), {
      target: { value: "2026-04-10" },
    });

    fireEvent.click(screen.getByRole("button", { name: /export as pdf/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/proxy/api/v1/records/export/pdf?patient_id=1&doctor_id=99&date_from=2026-04-01&date_to=2026-04-10&type=appointments",
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
