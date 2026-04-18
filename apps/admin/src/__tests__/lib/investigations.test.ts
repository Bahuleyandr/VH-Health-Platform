import { uploadBookingResult } from "@/lib/api/investigations";
import { apiFetch } from "@/lib/api-fetch";

jest.mock("@/lib/api-fetch", () => ({
  apiFetch: jest.fn(),
}));

const mockedApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

describe("uploadBookingResult", () => {
  it("uploads multipart form data without forwarding a token option", async () => {
    mockedApiFetch.mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue({
        data: { id: 77, booking_number: "BK-77" },
      }),
    } as unknown as Response);

    const file = new File(["pdf-content"], "report.pdf", { type: "application/pdf" });
    const result = await uploadBookingResult(77, file, "all clear");

    expect(result).toEqual({ id: 77, booking_number: "BK-77" });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockedApiFetch.mock.calls[0];
    expect(url).toBe("/api/v1/investigations/bookings/77/result");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    expect((init as Record<string, unknown>).token).toBeUndefined();
  });

  it("throws a meaningful error message when upload fails", async () => {
    mockedApiFetch.mockResolvedValueOnce({
      ok: false,
      json: jest.fn().mockResolvedValue({ message: "File scan failed" }),
    } as unknown as Response);

    const file = new File(["bad"], "bad.pdf", { type: "application/pdf" });

    await expect(uploadBookingResult(11, file)).rejects.toThrow("File scan failed");
  });
});
