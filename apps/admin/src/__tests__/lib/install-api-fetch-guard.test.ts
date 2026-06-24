describe("installApiFetchGuard", () => {
  beforeEach(() => {
    jest.resetModules();
    (window as Window & { __fetchGuardInstalled?: boolean }).__fetchGuardInstalled = undefined;
    (window as Window & { __fetchGuardApiBase?: string }).__fetchGuardApiBase = undefined;
  });

  it("rewrites top-level API paths to /api/proxy/api/v1/* and adds default query params", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/users");

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch.mock.calls[0][0]).toBe("/api/proxy/api/v1/users?page=1&limit=20");
  });

  it("preserves static/internal paths as passthrough requests", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/_next/static/chunk.js");

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch.mock.calls[0][0]).toBe("/_next/static/chunk.js");
  });

  it("adds API defaults while removing manual Origin header", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/users", {
      method: "POST",
      body: JSON.stringify({ x: 1 }),
      headers: {},
    });

    const init = originalFetch.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);

    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("origin")).toBe(false);
  });

  it("does not force content-type for FormData uploads", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    const form = new FormData();
    form.append("file", "a");

    await window.fetch("/investigations/bookings/1/result", {
      method: "POST",
      body: form,
    });

    const init = originalFetch.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("accept")).toBe("application/json");
  });

  it("passes through absolute external URLs unchanged", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("https://example.com/status");

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch.mock.calls[0][0]).toBe("https://example.com/status");
  });

  it("applies legacy logs/system alias to admin activity endpoint", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/logs/system?page=2&limit=20");

    const calledUrl = originalFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/proxy/api/v1/admin/activity/recent");
    expect(calledUrl).toContain("limit=20");
    expect(calledUrl).toContain("offset=20");
  });

  it("normalizes legacy admin upload route to admin/uploads", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/admin/upload/quarantine");

    const calledUrl = originalFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/proxy/api/v1/admin/uploads/quarantine");
  });

  it("rewrites absolute same-host api URLs by stripping base and applying rules", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    const absoluteUrl = `${window.location.origin}/api/proxy/users`;
    await window.fetch(absoluteUrl);

    expect(originalFetch).toHaveBeenCalledTimes(1);
    const calledUrl = originalFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/proxy/api/v1/users?page=1&limit=20");
  });

  it("passes through static asset paths matched by extension", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/assets/logo.png");

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch.mock.calls[0][0]).toBe("/assets/logo.png");
  });

  it("maps legacy /admin/statistics to /admin/stats/quick", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/admin/statistics");

    const calledUrl = originalFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/proxy/api/v1/admin/stats/quick");
  });

  it("maps /system/status to /health/system", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/system/status");

    const calledUrl = originalFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/proxy/api/v1/health/system");
  });

  it("maps /appointments to /appointments/list with paging defaults", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/appointments");

    const calledUrl = originalFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/proxy/api/v1/appointments/list?page=1&limit=20");
  });

  it("maps /pharmacy-orders to /pharmacy/orders with defaults", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/pharmacy-orders");

    const calledUrl = originalFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/proxy/api/v1/pharmacy/orders?page=1&limit=10");
  });

  it("maps /analytics to /analytics/dashboard", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/analytics");

    const calledUrl = originalFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/proxy/api/v1/analytics/dashboard");
  });

  it("keeps /notifications/stats and applies /api/v1 prefix", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/notifications/stats");

    const calledUrl = originalFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/proxy/api/v1/notifications/stats");
  });
});
