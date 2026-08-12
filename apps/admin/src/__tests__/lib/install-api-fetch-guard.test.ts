describe("installApiFetchGuard", () => {
  beforeEach(() => {
    jest.resetModules();
    (window as Window & { __fetchGuardInstalled?: boolean }).__fetchGuardInstalled = undefined;
    (window as Window & { __fetchGuardApiBase?: string }).__fetchGuardApiBase = undefined;
  });

  it("prefixes top-level API paths without changing their query", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/users");

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch.mock.calls[0][0]).toBe("/api/proxy/api/v1/users");
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

  it("adds default API headers while removing manual Origin header", async () => {
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

  it("preserves logs/system paths and their query parameters", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/logs/system?page=2&limit=20");

    expect(originalFetch.mock.calls[0][0]).toBe(
      "/api/proxy/api/v1/logs/system?page=2&limit=20",
    );
  });

  it("preserves singular admin upload paths", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    await window.fetch("/admin/upload/quarantine");

    expect(originalFetch.mock.calls[0][0]).toBe(
      "/api/proxy/api/v1/admin/upload/quarantine",
    );
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
    expect(calledUrl).toBe("/api/proxy/api/v1/users");
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

  it("preserves pharmacy order subpaths, method, and body", async () => {
    const originalFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    window.fetch = originalFetch as unknown as typeof window.fetch;

    const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
    installApiFetchGuard();

    const body = JSON.stringify({ dispensedQuantity: 1 });
    await window.fetch("/pharmacy-orders/orders/123/dispense", {
      method: "POST",
      body,
    });

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch.mock.calls[0][0]).toBe(
      "/api/proxy/api/v1/pharmacy-orders/orders/123/dispense",
    );
    expect(originalFetch.mock.calls[0][1]).toMatchObject({ method: "POST", body });
  });

  it.each(["/system/settings", "/logs/audit/export"])(
    "preserves the complete backend subpath for %s",
    async (path) => {
      const originalFetch = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      window.fetch = originalFetch as unknown as typeof window.fetch;

      const { installApiFetchGuard } = await import("@/lib/install-api-fetch-guard");
      installApiFetchGuard();

      await window.fetch(path);

      expect(originalFetch).toHaveBeenCalledTimes(1);
      expect(originalFetch.mock.calls[0][0]).toBe(`/api/proxy/api/v1${path}`);
    },
  );

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
