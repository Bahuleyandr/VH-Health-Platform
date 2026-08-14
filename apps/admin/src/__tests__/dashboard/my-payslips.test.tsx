import MyPayslipsPage from "@/app/(with-auth)/dashboard/my-payslips/page";
import { fetchAdminAPI } from "@/lib/api";
import { API_ENDPOINTS } from "@/lib/api-config";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn(),
}));

const fetchAdminAPIMock = fetchAdminAPI as jest.MockedFunction<
  typeof fetchAdminAPI
>;
const fetchMock = jest.fn();
const writeTextMock = jest.fn();

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MyPayslipsPage />
    </QueryClientProvider>,
  );
}

const backendPayslip = {
  id: 7,
  month: "4",
  year: "2026",
  gross_salary: "60000.00",
  net_salary: "48123.45",
  total_deductions: "11876.55",
  status: "ISSUED",
};

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  writeTextMock.mockReset();
  global.fetch = fetchMock as typeof fetch;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writeTextMock },
  });
  fetchAdminAPIMock.mockResolvedValue({ data: [backendPayslip] });
});

test("normalizes the backend payslip fields without automatically revealing", async () => {
  renderPage();

  expect(await screen.findByText("April 2026")).toBeInTheDocument();
  expect(screen.getByText(/Gross: ₹60,000\.00/)).toBeInTheDocument();
  expect(screen.getByText(/Deductions: ₹11,876\.55/)).toBeInTheDocument();
  expect(screen.getByText(/Net: ₹48,123\.45/)).toBeInTheDocument();
  expect(screen.getByText("issued")).toBeInTheDocument();
  expect(fetchAdminAPIMock).toHaveBeenCalledWith(
    "/api/v1/staff/hr/payroll/my-payslips",
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(API_ENDPOINTS.myWork.payslips.password("7")).toBe(
    "/api/v1/staff/hr/payroll/my-payslips/7/password",
  );
});

test("POSTs only on gesture, masks transient state, clears it, and handles 404 safely", async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writeTextMock },
  });
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: { password: "PDF-only-secret" } }),
    } as Response)
    .mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        message: "backend credential PDF-only-secret must not echo",
      }),
    } as Response);
  renderPage();
  await screen.findByText("April 2026");

  await user.click(screen.getByRole("button", { name: "View PDF password" }));

  const dialog = await screen.findByRole("dialog", {
    name: "Payslip PDF password",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/proxy/api/v1/staff/hr/payroll/my-payslips/7/password",
    expect.objectContaining({
      method: "POST",
      body: "{}",
      cache: "no-store",
    }),
  );
  const passwordField = screen.getByLabelText("Masked payslip PDF password");
  expect(passwordField).toHaveAttribute("type", "password");
  expect(passwordField).toHaveValue("PDF-only-secret");
  expect(screen.queryByText("PDF-only-secret")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Show" }));
  expect(passwordField).toHaveAttribute("type", "text");
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(writeTextMock).toHaveBeenCalledWith("PDF-only-secret");
  expect(await screen.findByText("Copied.")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(dialog).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Masked payslip PDF password"),
  ).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "View PDF password" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(
    await screen.findByText("A password is not available for this payslip."),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/backend credential|PDF-only-secret must not echo/),
  ).not.toBeInTheDocument();
});

test("clears a revealed credential when the page is hidden for navigation", async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ data: { password: "PDF-only-secret" } }),
  } as Response);
  renderPage();
  await screen.findByText("April 2026");
  await user.click(screen.getByRole("button", { name: "View PDF password" }));
  await screen.findByRole("dialog", { name: "Payslip PDF password" });

  act(() => window.dispatchEvent(new Event("pagehide")));

  await waitFor(() =>
    expect(
      screen.queryByLabelText("Masked payslip PDF password"),
    ).not.toBeInTheDocument(),
  );
});
