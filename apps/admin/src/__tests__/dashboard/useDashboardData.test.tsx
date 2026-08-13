import { act, renderHook, waitFor } from "@testing-library/react";
import { useDashboardData } from "@/app/(with-auth)/dashboard/hooks/useDashboardData";
import { API_BASE_URL, API_ENDPOINTS } from "@/lib/api-config";

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const { status = 200, ok = status >= 200 && status < 300 } = init;
  return {
    ok,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

type DashboardFixture = {
  dashboard: {
    overview: {
      totalUsers?: number;
      presentStaff: number;
      availableDoctors: number;
      appointmentsToday: number;
    };
    charts: {
      userGrowth: Array<{ date: string; value: number }>;
      appointmentTrends: Array<{ date: string; value: number }>;
    };
    recentActivity?: Array<{
      id: string;
      user: string;
      action: string;
      target: string;
      department?: string;
      timestamp: string;
    }>;
    systemHealth?: {
      status: "healthy" | "warning" | "critical";
      uptime: string;
      responseTime: number;
      errorRate: number;
    };
  };
  quickStats: { totalUsers: number };
  recentActivity: Array<{
    id: string;
    user: string;
    action: string;
    target: string;
    department?: string;
    timestamp: string;
  }>;
  systemHealth: {
    status: "healthy" | "warning" | "critical";
    uptime: string;
    responseTime: number;
    errorRate: number;
  };
  appointmentStats: { waiting: number; in_progress?: number; inProgress?: number; completed: number };
  moduleHealth: Array<{ name: string; status: string }>;
};

function queueDashboardFetches(fetchMock: jest.MockedFunction<typeof fetch>, fixture: DashboardFixture) {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ success: true, data: fixture.dashboard }))
    .mockResolvedValueOnce(jsonResponse({ success: true, data: fixture.quickStats }))
    .mockResolvedValueOnce(jsonResponse({ success: true, data: fixture.recentActivity }))
    .mockResolvedValueOnce(jsonResponse({ success: true, data: fixture.systemHealth }))
    .mockResolvedValueOnce(jsonResponse({ success: true, data: fixture.appointmentStats }))
    .mockResolvedValueOnce(jsonResponse({ success: true, data: fixture.moduleHealth }));
}

describe("useDashboardData", () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });
  });

  it("unwraps the dashboard envelope and normalizes data from proxied admin endpoints", async () => {
    queueDashboardFetches(fetchMock, {
      dashboard: {
        overview: {
          presentStaff: 18,
          availableDoctors: 6,
          appointmentsToday: 24,
        },
        charts: {
          userGrowth: [
            { date: "2026-04-14", value: 101 },
            { date: "2026-04-15", value: 108 },
          ],
          appointmentTrends: [
            { date: "2026-04-14", value: 22 },
            { date: "2026-04-15", value: 24 },
          ],
        },
        recentActivity: [
          {
            id: "dash-fallback",
            user: "System",
            action: "synced",
            target: "records",
            timestamp: "2026-04-18T09:00:00.000Z",
          },
        ],
        systemHealth: {
          status: "warning",
          uptime: "99.50%",
          responseTime: 180,
          errorRate: 1.4,
        },
      },
      quickStats: { totalUsers: 245 },
      recentActivity: [
        {
          id: "recent-1",
          user: "Asha",
          action: "reviewed",
          target: "payroll",
          department: "HR",
          timestamp: "2026-04-18T10:00:00.000Z",
        },
      ],
      systemHealth: {
        status: "healthy",
        uptime: "99.99%",
        responseTime: 45,
        errorRate: 0.2,
      },
      appointmentStats: { waiting: 4, in_progress: 3, completed: 17 },
      moduleHealth: [
        { name: "Database", status: "healthy" },
        { name: "Messaging", status: "degraded" },
      ],
    });

    const { result } = renderHook(() => useDashboardData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${API_BASE_URL}${API_ENDPOINTS.admin.dashboard}`,
      `${API_BASE_URL}${API_ENDPOINTS.admin.stats.quick}`,
      `${API_BASE_URL}${API_ENDPOINTS.admin.activity.recent}?limit=10&offset=0`,
      `${API_BASE_URL}${API_ENDPOINTS.admin.health.system}`,
      `${API_BASE_URL}${API_ENDPOINTS.admin.stats.appointments}`,
      `${API_BASE_URL}${API_ENDPOINTS.admin.health.modules}`,
    ]);

    expect(result.current.quick).toEqual({
      totalUsers: 245,
      presentStaff: 18,
      availableDoctors: 6,
      appointmentsToday: 24,
    });
    expect(result.current.queue).toEqual({ waiting: 4, inProgress: 3, completed: 17 });
    expect(result.current.charts).toEqual({
      labels: ["2026-04-14", "2026-04-15"],
      users: [101, 108],
      appts: [22, 24],
    });
    expect(result.current.activity).toEqual([
      {
        id: "recent-1",
        user: "Asha",
        action: "reviewed",
        target: "payroll",
        department: "HR",
        timestamp: "2026-04-18T10:00:00.000Z",
      },
    ]);
    expect(result.current.health).toEqual({
      status: "healthy",
      uptime: "99.99%",
      responseTime: 45,
      errorRate: 0.2,
      modules: [
        { name: "Database", status: "healthy" },
        { name: "Messaging", status: "warning" },
      ],
      observedAt: expect.any(String),
    });
  });

  it("keeps previous quick stats and queue values when refreshCache reloads the dashboard", async () => {
    queueDashboardFetches(fetchMock, {
      dashboard: {
        overview: {
          presentStaff: 9,
          availableDoctors: 4,
          appointmentsToday: 12,
        },
        charts: {
          userGrowth: [{ date: "2026-04-14", value: 75 }],
          appointmentTrends: [{ date: "2026-04-14", value: 12 }],
        },
      },
      quickStats: { totalUsers: 120 },
      recentActivity: [],
      systemHealth: {
        status: "healthy",
        uptime: "99.95%",
        responseTime: 61,
        errorRate: 0.3,
      },
      appointmentStats: { waiting: 2, in_progress: 1, completed: 8 },
      moduleHealth: [{ name: "Database", status: "healthy" }],
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, message: "refreshed" }));
    queueDashboardFetches(fetchMock, {
      dashboard: {
        overview: {
          presentStaff: 11,
          availableDoctors: 5,
          appointmentsToday: 14,
        },
        charts: {
          userGrowth: [{ date: "2026-04-15", value: 81 }],
          appointmentTrends: [{ date: "2026-04-15", value: 14 }],
        },
      },
      quickStats: { totalUsers: 126 },
      recentActivity: [],
      systemHealth: {
        status: "warning",
        uptime: "99.80%",
        responseTime: 90,
        errorRate: 0.8,
      },
      appointmentStats: { waiting: 5, inProgress: 3, completed: 10 },
      moduleHealth: [{ name: "Database", status: "warning" }],
    });

    const { result } = renderHook(() => useDashboardData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.quick).toEqual({
      totalUsers: 120,
      presentStaff: 9,
      availableDoctors: 4,
      appointmentsToday: 12,
    });
    expect(result.current.queue).toEqual({ waiting: 2, inProgress: 1, completed: 8 });

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(fetchMock.mock.calls[6]?.[0]).toBe(`${API_BASE_URL}${API_ENDPOINTS.admin.reports.refreshCache}`);
    expect(fetchMock.mock.calls[6]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
      }),
    );

    expect(result.current.prevQuick).toEqual({
      totalUsers: 120,
      presentStaff: 9,
      availableDoctors: 4,
      appointmentsToday: 12,
    });
    expect(result.current.quick).toEqual({
      totalUsers: 126,
      presentStaff: 11,
      availableDoctors: 5,
      appointmentsToday: 14,
    });
    expect(result.current.prevQueue).toEqual({ waiting: 2, inProgress: 1, completed: 8 });
    expect(result.current.queue).toEqual({ waiting: 5, inProgress: 3, completed: 10 });
  });

  it("marks the last health observation stale when a later health request fails", async () => {
    let healthCalls = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(API_ENDPOINTS.admin.reports.refreshCache)) {
        return jsonResponse({ success: true });
      }
      if (url.endsWith(API_ENDPOINTS.admin.dashboard)) {
        return jsonResponse({
          data: {
            overview: {},
            charts: { userGrowth: [], appointmentTrends: [] },
          },
        });
      }
      if (url.endsWith(API_ENDPOINTS.admin.stats.quick)) {
        return jsonResponse({ data: {} });
      }
      if (url.includes(API_ENDPOINTS.admin.activity.recent)) {
        return jsonResponse({ data: [] });
      }
      if (url.endsWith(API_ENDPOINTS.admin.health.system)) {
        healthCalls += 1;
        return healthCalls === 1
          ? jsonResponse({
              data: {
                status: "up",
                uptime: "99.9%",
                responseTime: 50,
                errorRate: 0.1,
              },
            })
          : jsonResponse({ message: "unavailable" }, { status: 503 });
      }
      if (url.endsWith(API_ENDPOINTS.admin.stats.appointments)) {
        return jsonResponse({ data: {} });
      }
      if (url.endsWith(API_ENDPOINTS.admin.health.modules)) {
        return jsonResponse({ data: [{ name: "Database", status: "up" }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.health.status).toBe("healthy"));
    const observedAt = result.current.health.observedAt;

    await act(async () => {
      await result.current.refreshCache();
    });

    expect(result.current.health).toEqual(
      expect.objectContaining({
        status: "stale",
        lastKnownStatus: "healthy",
        observedAt,
        responseTime: 50,
        modules: [{ name: "Database", status: "healthy" }],
      }),
    );
  });
});
