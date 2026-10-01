import { DataExporter } from "@/app/(with-auth)/dashboard/reporting/components/DataExporter";
import { ReportGenerator } from "@/app/(with-auth)/dashboard/reporting/components/ReportGenerator";
import type { Doctor, User } from "@/lib/types";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

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
    clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    clickSpy.mockRestore();
  });

  it("downloads appointment exports through the proxied /api/v1 route with backend query names", async () => {
    fetchMock.mockResolvedValueOnce(
      blobResponse("id,name\n1,Asha", "text/csv"),
    );

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
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
  });

  it("routes filtered record exports through the proxied record export endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      blobResponse("%PDF-1.4", "application/pdf"),
    );

    render(
      <ReportGenerator
        users={[{ id: 1, name: "Asha", email: "asha@example.com" } as User]}
        doctors={[
          {
            user_id: 99,
            name: "Mehta",
            specialization: "Cardiology",
          } as Doctor,
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
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
  });

  it.each([
    [
      "Staff HR Report",
      "/api/proxy/api/v1/staff/hr/export-report?format=csv&report_type=attendance&start_date=",
    ],
    ["Departments CSV", "/api/proxy/api/v1/departments/admin/export/csv"],
  ])(
    "previews %s through its existing credentialed route",
    async (label, path) => {
      fetchMock.mockResolvedValueOnce(
        blobResponse('Name,Note\n"Doe, Jane","One\nTwo"', "text/csv"),
      );
      render(<DataExporter />);
      const card = screen.getByText(label).closest("div");
      if (!card) throw new Error("CSV export card not found");
      fireEvent.click(
        within(card).getByRole("button", { name: /^download$/i }),
      );

      const table = await screen.findByRole("table");
      expect(
        within(table)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      ).toEqual(["Doe, Jane", "One\nTwo"]);
      expect(String(fetchMock.mock.calls[0][0])).toContain(path);
      expect(fetchMock.mock.calls[0][1]).toEqual({ credentials: "include" });
      await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    },
  );

  it("previews quoted CSV cells without changing the downloaded bytes", async () => {
    const csv =
      '\uFEFFName,Role,Note,End\r\n"Doe, Jane",Doctor,"Said ""hello""\r\nAgain",\r\n';
    const blob = new Blob([csv], { type: "text/csv" });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      blob: jest.fn().mockResolvedValue(blob),
    } as unknown as Response);

    render(<DataExporter />);
    fireEvent.click(screen.getAllByRole("button", { name: /^download$/i })[0]);

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(
      within(rows[1])
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["Doe, Jane", "Doctor", 'Said "hello"\r\nAgain', ""]);
    expect(rows).toHaveLength(2);
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new TextEncoder().encode(csv),
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  it("preserves duplicate headers and displays only the first five logical rows", async () => {
    const csv =
      'Name,Name,Note\n"Doe, Jane",Doctor,"first\nsecond"\nTwo,Role,Note\nThree,Role,Note\nFour,Role,Note\nFive,Role,Note\nSix,Role,Note\n';
    fetchMock.mockResolvedValueOnce(blobResponse(csv, "text/csv"));
    render(<DataExporter />);
    fireEvent.click(screen.getAllByRole("button", { name: /^download$/i })[0]);

    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Name", "Name", "Note"]);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(6);
    expect(
      within(rows[1])
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["Doe, Jane", "Doctor", "first\nsecond"]);
    const noteCell = within(rows[1]).getAllByRole("cell")[2];
    expect(noteCell).toHaveClass("whitespace-pre-wrap", "break-words");
    expect(noteCell).not.toHaveClass("whitespace-nowrap");
    expect(noteCell).not.toHaveClass("truncate");
    expect(screen.getByText("Showing first 5 of 6 rows")).toBeInTheDocument();
    expect(screen.queryByText("Six")).not.toBeInTheDocument();
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
  });

  it.each(["", "Name,Note\r\n"])("shows zero data rows for %j", async (csv) => {
    fetchMock.mockResolvedValueOnce(blobResponse(csv, "text/csv"));
    render(<DataExporter />);
    fireEvent.click(screen.getAllByRole("button", { name: /^download$/i })[0]);

    await screen.findByText("Export Preview");
    expect(screen.getByText("Rows:").parentElement).toHaveTextContent(
      "Rows: 0",
    );
    expect(screen.queryAllByRole("cell")).toHaveLength(0);
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
  });

  it.each(['"unfinished', "Six,extra"])(
    "discloses a malformed row after the preview limit: %j",
    async (lastRecord) => {
      const csv = `Name\nOne\nTwo\nThree\nFour\nFive\n${lastRecord}`;
      const blob = new Blob([csv], { type: "text/csv" });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        blob: jest.fn().mockResolvedValue(blob),
      } as unknown as Response);
      render(<DataExporter />);
      fireEvent.click(
        screen.getAllByRole("button", { name: /^download$/i })[0],
      );

      expect(
        await screen.findByText(/CSV preview unavailable/i),
      ).toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.queryByText("Rows:")).not.toBeInTheDocument();
      await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
      expect(createObjectURL).toHaveBeenCalledWith(blob);
      expect(await blob.text()).toBe(csv);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
    },
  );

  it("discloses a failed preview read without blocking the download", async () => {
    const blob = new Blob(["Name\nJane"], { type: "text/csv" });
    jest
      .spyOn(blob, "text")
      .mockRejectedValueOnce(new Error("synthetic read failure"));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      blob: jest.fn().mockResolvedValue(blob),
    } as unknown as Response);
    render(<DataExporter />);
    fireEvent.click(screen.getAllByRole("button", { name: /^download$/i })[0]);

    expect(
      await screen.findByText(/CSV preview unavailable/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/synthetic read failure/),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  it("clears an unavailable preview when a subsequent export parses", async () => {
    fetchMock
      .mockResolvedValueOnce(blobResponse('Name\n"unfinished', "text/csv"))
      .mockResolvedValueOnce(blobResponse("Name\nJane", "text/csv"));
    render(<DataExporter />);
    const download = screen.getAllByRole("button", { name: /^download$/i })[0];
    fireEvent.click(download);
    await screen.findByText(/CSV preview unavailable/i);
    await waitFor(() => expect(download).toBeEnabled());

    fireEvent.click(download);
    await screen.findByRole("table");
    expect(
      screen.queryByText(/CSV preview unavailable/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("cell")).toHaveTextContent("Jane");
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(2));
  });

  it.each([
    [
      "Records (Excel)",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    ["Records (PDF)", "application/pdf"],
  ])("downloads %s without reading it as CSV", async (label, type) => {
    const blob = new Blob(["binary export"], { type });
    const textSpy = jest.spyOn(blob, "text");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      blob: jest.fn().mockResolvedValue(blob),
    } as unknown as Response);
    render(<DataExporter />);
    const card = screen.getByText(label).closest("div");
    if (!card) throw new Error("Records export card not found");
    fireEvent.click(within(card).getByRole("button", { name: /^download$/i }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    expect(textSpy).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
    expect(screen.queryByText("Export Preview")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/CSV preview unavailable/i),
    ).not.toBeInTheDocument();
  });

  it("renders CSV markup as text and retains formula-neutralization prefixes", async () => {
    const cell = "<img src=x onerror=alert(1)>";
    fetchMock.mockResolvedValueOnce(
      blobResponse(`Value\n${cell}\n'=SUM(A1:A2)`, "text/csv"),
    );
    render(<DataExporter />);
    fireEvent.click(screen.getAllByRole("button", { name: /^download$/i })[0]);

    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("cell")
        .map((td) => td.textContent),
    ).toEqual([cell, "'=SUM(A1:A2)"]);
    expect(table.querySelector("img")).toBeNull();
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
  });

  it("does not preview or download a denied export", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: jest.fn().mockResolvedValue("Access denied"),
    } as unknown as Response);
    render(<DataExporter />);
    fireEvent.click(screen.getAllByRole("button", { name: /^download$/i })[0]);

    expect(await screen.findByText("Access denied")).toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("Export Preview")).not.toBeInTheDocument();
  });
});
