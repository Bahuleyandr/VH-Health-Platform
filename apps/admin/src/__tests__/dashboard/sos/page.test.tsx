import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SosPage from "@/app/(with-auth)/dashboard/sos/page";
import { adminService } from "@/services/admin.service";

jest.mock("@/services/admin.service", () => ({
  adminService: {
    getSosAnalytics: jest.fn(),
    getSosPerformanceReport: jest.fn(),
    getEmergencyServices: jest.fn(),
    listSosAlerts: jest.fn(),
    broadcastSosAlert: jest.fn(),
  },
}));

const service = adminService as jest.Mocked<typeof adminService>;

beforeEach(() => {
  jest.clearAllMocks();
  service.getSosAnalytics.mockResolvedValue({ data: {} });
  service.getSosPerformanceReport.mockResolvedValue({ data: {} });
  service.getEmergencyServices.mockResolvedValue({ data: [] });
  service.listSosAlerts.mockResolvedValue({ data: [] });
});

async function sendBroadcast(message = "Evacuate ward three") {
  render(<SosPage />);
  await waitFor(() => expect(service.getSosAnalytics).toHaveBeenCalled());
  fireEvent.change(screen.getByPlaceholderText("Broadcast message…"), {
    target: { value: message },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Broadcast" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("shows the backend recipient count after a broadcast", async () => {
  service.broadcastSosAlert.mockResolvedValue({
    success: true,
    data: { notified: 2 },
    message: "Broadcast sent to 2 staff",
  });

  await sendBroadcast();

  expect(
    await screen.findByText("Broadcast sent to 2 staff members."),
  ).toBeInTheDocument();
});

it("does not claim success when the broadcast reached nobody", async () => {
  service.broadcastSosAlert.mockResolvedValue({
    success: true,
    data: { notified: 0 },
    message: "Broadcast sent to 0 staff",
  });

  await sendBroadcast();

  expect(
    await screen.findByText(
      "Broadcast reached no staff. Verify active staff phone numbers before retrying.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("Broadcast sent.")).not.toBeInTheDocument();
});
