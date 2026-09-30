describe("Fetch API dependency compatibility in jsdom", () => {
  it("preserves the configured browser environment and header behavior", () => {
    expect(window.document).toBe(document);
    expect(typeof fetch).toBe("function");
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("X-Test", "first");
    headers.append("x-test", "second");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("X-Test")).toBe("first, second");
  });

  it("preserves request bodies, headers, and cloning without network access", async () => {
    const request = new Request("https://admin.example.test/api/proxy/test", {
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled: true }),
    });
    const clone = request.clone();
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    await expect(request.json()).resolves.toEqual({ enabled: true });
    await expect(clone.json()).resolves.toEqual({ enabled: true });
    expect(request.bodyUsed).toBe(true);
  });

  it("preserves JSON response status, headers, and cloning", async () => {
    const response = Response.json(
      { success: true, data: { count: 2 } },
      { status: 201, headers: { "X-Test": "created" } },
    );
    const clone = response.clone();
    expect(response.ok).toBe(true);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("created");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { count: 2 },
    });
    await expect(clone.json()).resolves.toEqual({
      success: true,
      data: { count: 2 },
    });
  });

  it("preserves the configured FormData implementation and repeated fields", () => {
    const form = new FormData();
    form.append("label", "first");
    form.append("label", "second");
    expect(form.getAll("label")).toEqual(["first", "second"]);
    form.set("label", "replacement");
    expect(form.get("label")).toBe("replacement");
    form.delete("label");
    expect(form.has("label")).toBe(false);
  });
});
