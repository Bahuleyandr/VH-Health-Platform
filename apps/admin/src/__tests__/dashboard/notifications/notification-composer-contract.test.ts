import { buildNotificationComposerRequest } from "@/app/(with-auth)/dashboard/notifications/components/notificationComposerContract";
import { API_ENDPOINTS } from "@/lib/api-config";

describe("NotificationComposer backend request contract", () => {
  it("builds a broadcast announcement with canonical uppercase priority", () => {
    expect(
      buildNotificationComposerRequest({
        title: "  Planned maintenance ",
        message: "  Service may be slow ",
        type: "warning",
        target: "all",
        targetValue: "",
      }),
    ).toEqual({
      endpoint: API_ENDPOINTS.notifications.announcement,
      payload: {
        title: "Planned maintenance",
        message: "Service may be slow",
        priority: "MEDIUM",
        target_roles: [],
        target_departments: [],
      },
    });
  });

  it("uses target_roles and scheduled_for for role announcements", () => {
    const request = buildNotificationComposerRequest({
      title: "Emergency drill",
      message: "Report to the assembly point",
      type: "critical",
      target: "role",
      targetValue: "nursing_staff",
      scheduledDate: "2026-08-14",
      scheduledTime: "09:30",
    });

    expect(request.endpoint).toBe(API_ENDPOINTS.notifications.announcement);
    expect(request.payload).toEqual(
      expect.objectContaining({
        priority: "HIGH",
        target_roles: ["NURSING_STAFF"],
        target_departments: [],
        scheduled_for: expect.stringMatching(/^2026-08-14T/),
      }),
    );
    expect(request.payload).not.toHaveProperty("scheduledAt");
    expect(request.payload).not.toHaveProperty("targetValue");
  });

  it("uses the targeted contract for numeric user IDs", () => {
    expect(
      buildNotificationComposerRequest({
        title: "Result available",
        message: "Open your record",
        type: "info",
        target: "user",
        targetValue: "12, 18 12",
      }),
    ).toEqual({
      endpoint: API_ENDPOINTS.notifications.targeted,
      payload: {
        title: "Result available",
        message: "Open your record",
        type: "INFO",
        priority: "LOW",
        user_ids: [12, 18],
        criteria: {},
      },
    });
  });

  it("rejects phone-like or non-numeric values that the backend cannot target", () => {
    expect(() =>
      buildNotificationComposerRequest({
        title: "Hello",
        message: "Message",
        type: "info",
        target: "user",
        targetValue: "+919999999999",
      }),
    ).toThrow(/numeric user IDs/i);
  });
});
