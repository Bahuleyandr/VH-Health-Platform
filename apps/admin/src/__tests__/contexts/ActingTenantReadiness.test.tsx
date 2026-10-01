import PaymentGatewayConfigForm from "@/app/(with-auth)/dashboard/integration-gates/components/PaymentGatewayConfigForm";
import SmsConfigForm from "@/app/(with-auth)/dashboard/integration-gates/components/SmsConfigForm";
import {
  ActingTenantProvider,
  useActingTenant,
} from "@/contexts/ActingTenantContext";
import type { ActingTenantValue } from "@/contexts/ActingTenantContext";
import {
  upsertPaymentGatewayConfig,
  upsertSmsConfig,
  registerSmsTemplate,
} from "@/lib/api/integrationGates";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  onlineManager,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useLayoutEffect, type ReactNode } from "react";

jest.mock("@/lib/api/integrationGates", () => ({
  upsertPaymentGatewayConfig: jest.fn(),
  upsertSmsConfig: jest.fn(),
  registerSmsTemplate: jest.fn(),
  listSmsTemplates: jest.fn().mockResolvedValue({ templates: [] }),
}));

const TENANT = {
  id: "a5a5a5a5-c5c5-4a5a-8a5a-a5a5c5c5aa01",
  slug: "synthetic",
  reason: "Synthetic support",
};
let mockAuth = {
  user: { uid: "synthetic-admin", id: 1, role: "SUPER_ADMIN" },
  loading: false,
  sessionRevision: 1,
  isSessionCurrent: (revision: number) => revision === mockAuth.sessionRevision,
} as {
  user: { uid: string; id: number; role: string } | null;
  loading: boolean;
  sessionRevision: number;
  isSessionCurrent: (revision: number) => boolean;
};
jest.mock("@/contexts/AuthContext", () => ({ useAuth: () => mockAuth }));

let current: ActingTenantValue;
let clients: QueryClient[];
let drains: (() => void)[];
function response(actingTenant: unknown = null): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ actingTenant }),
  } as Response;
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  drains.push(() => resolve(response()));
  return { promise, resolve };
}
function Probe() {
  const value = useActingTenant();
  useLayoutEffect(() => {
    current = value;
  }, [value]);
  return (
    <div>
      <span data-testid="status">{value.status}</span>
      <span data-testid="ready">{String(value.isReady)}</span>
      <span data-testid="pending">{String(value.isPending)}</span>
      <span data-testid="tenant">{value.actingTenant?.id ?? "none"}</span>
      <span data-testid="scope">{value.scopeKey ?? "unresolved"}</span>
      <span data-testid="error">{value.error?.message ?? "none"}</span>
    </div>
  );
}
function DependentProbe({
  onRead,
}: {
  onRead: (tenantId: string | null, ready: boolean) => void;
}) {
  const { actingTenant, isReady } = useActingTenant();
  useQuery({
    queryKey: ["tenant-dependent"],
    enabled: isReady,
    staleTime: Infinity,
    queryFn: async () => {
      onRead(actingTenant?.id ?? null, isReady);
      return "synthetic tenant data";
    },
  });
  return null;
}

function fixture(children?: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 60000, refetchOnWindowFocus: false },
    },
  });
  clients.push(qc);
  const tree = () => (
    <QueryClientProvider client={qc}>
      <ActingTenantProvider>
        <Probe />
        {children}
      </ActingTenantProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { qc, rerender: () => view.rerender(tree()) };
}

function ProviderForms() {
  const { isReady, scopeKey } = useActingTenant();
  if (!isReady || !scopeKey) return null;
  return (
    <div key={scopeKey}>
      <PaymentGatewayConfigForm scopeKey={scopeKey} />
      <SmsConfigForm scopeKey={scopeKey} />
    </div>
  );
}
async function ready() {
  await waitFor(() =>
    expect(screen.getByTestId("ready")).toHaveTextContent("true"),
  );
}
function blocked() {
  expect(screen.getByTestId("ready")).toHaveTextContent("false");
  expect(screen.getByTestId("pending")).toHaveTextContent("true");
  expect(screen.getByTestId("scope")).toHaveTextContent("unresolved");
  expect(screen.getByTestId("tenant")).toHaveTextContent("none");
}

beforeEach(() => {
  clients = [];
  drains = [];
  mockAuth = {
    user: { uid: "synthetic-admin", id: 1, role: "SUPER_ADMIN" },
    loading: false,
    sessionRevision: 1,
    isSessionCurrent: (revision: number) =>
      revision === mockAuth.sessionRevision,
  };
});
afterEach(async () => {
  cleanup();
  onlineManager.setOnline(true);
  await act(async () => {
    drains.forEach((drain) => drain());
    await Promise.resolve();
  });
  clients.forEach((qc) => qc.clear());
  jest.restoreAllMocks();
});

it("throws outside the acting-tenant provider", () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  expect(() => render(<Probe />)).toThrow(/ActingTenantProvider/);
});

it("blocks while the initial GET is unresolved", async () => {
  const read = deferred();
  jest.spyOn(global, "fetch").mockReturnValue(read.promise);
  fixture();
  blocked();
  await act(async () => {
    await expect(current.clear()).rejects.toThrow();
  });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    read.resolve(response());
  });
  await ready();
});

it("accepts only a successful explicit null as a settled own-tenant mirror", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue(response());
  fixture();
  await ready();
  expect(current.actingTenant).toBeNull();
  expect(current.error).toBeNull();
  expect(current.scopeKey).not.toBeNull();
});

it.each([401, 403, 404, 500])(
  "does not interpret HTTP %s as own-tenant scope",
  async (status) => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status,
      json: async () => ({ actingTenant: null }),
    } as Response);
    fixture();
    await waitFor(() => expect(current.status).toBe("error"));
    blocked();
    expect(current.error).toBeInstanceOf(Error);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  },
);

it.each([
  {},
  [],
  { actingTenant: {} },
  { actingTenant: { ...TENANT, id: "not-a-uuid" } },
  { actingTenant: { ...TENANT, reason: 3 } },
])("rejects a malformed successful response: %j", async (body) => {
  jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as Response);
  fixture();
  await waitFor(() => expect(current.status).toBe("error"));
  blocked();
});

it.each(["network", "JSON"])(
  "keeps %s failures unresolved",
  async (failure) => {
    const fetchMock = jest.spyOn(global, "fetch");
    if (failure === "network")
      fetchMock.mockRejectedValue(new Error("Connection lost"));
    else
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Bad JSON");
        },
      } as unknown as Response);
    fixture();
    await waitFor(() => expect(current.status).toBe("error"));
    blocked();
  },
);

it("read retry performs a fresh GET and no write", async () => {
  const fetchMock = jest
    .spyOn(global, "fetch")
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce(response(TENANT));
  fixture();
  await waitFor(() => expect(current.status).toBe("error"));
  await act(async () => {
    await current.retry();
  });
  await ready();
  expect(current.actingTenant).toEqual(TENANT);
  expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
    "GET",
    "GET",
  ]);
});

it.each(["loading", "signed-out"])(
  "does not read or mutate while authentication is %s",
  async (state) => {
    mockAuth.loading = state === "loading";
    if (state === "signed-out") mockAuth.user = null;
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(response());
    fixture();
    blocked();
    await act(async () => {
      await expect(current.retry()).rejects.toThrow();
      await expect(current.clear()).rejects.toThrow();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each(["identity", "revision", "loading"])(
  "discards prior scope immediately on an authentication %s change",
  async (change) => {
    const second = deferred();
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(response(TENANT))
      .mockReturnValueOnce(second.promise);
    const view = fixture();
    await ready();
    const savedScope = current;
    const oldScope = current.scopeKey;
    if (change === "identity")
      mockAuth.user = { uid: "other-admin", id: 2, role: "ADMIN" };
    if (change === "revision") mockAuth.sessionRevision += 1;
    if (change === "loading") mockAuth.loading = true;
    view.rerender();
    blocked();
    expect(savedScope.isScopeCurrent(oldScope!)).toBe(false);
    if (change === "loading") {
      mockAuth.loading = false;
      mockAuth.sessionRevision += 1;
      view.rerender();
    }
    await act(async () => {
      second.resolve(response());
    });
    await ready();
    expect(current.scopeKey).not.toEqual(oldScope);
  },
);

it("ignores an old authentication session's late GET", async () => {
  const oldRead = deferred();
  jest
    .spyOn(global, "fetch")
    .mockReturnValueOnce(oldRead.promise)
    .mockResolvedValueOnce(response());
  const view = fixture();
  mockAuth.sessionRevision += 1;
  view.rerender();
  await ready();
  const newScope = current.scopeKey;
  await act(async () => {
    oldRead.resolve(response(TENANT));
  });
  expect(current.scopeKey).toBe(newScope);
  expect(current.actingTenant).toBeNull();
});

it.each(["POST", "DELETE"])(
  "publishes a successful %s before dependent invalidation, without another GET",
  async (method) => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(response(method === "DELETE" ? TENANT : null))
      .mockResolvedValueOnce(response(method === "POST" ? TENANT : null));
    const { qc } = fixture();
    await ready();
    const invalidate = jest
      .spyOn(qc, "invalidateQueries")
      .mockImplementation(async () => {
        const query = qc
          .getQueryCache()
          .findAll({ queryKey: ["acting-tenant"] });
        expect(query).toHaveLength(1);
        expect(query[0].state.data).toEqual(method === "POST" ? TENANT : null);
      });
    await act(async () => {
      if (method === "POST")
        await current.setActAs({ tenantId: TENANT.id, reason: TENANT.reason });
      else await current.clear();
    });
    await ready();
    expect(invalidate).toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      method,
    ]);
  },
);

it.each(["POST", "DELETE"])(
  "renders the settled %s scope before real dependent observers refetch",
  async (method) => {
    const initialTenant = method === "DELETE" ? TENANT : null;
    const finalTenant = method === "POST" ? TENANT : null;
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(response(initialTenant))
      .mockResolvedValueOnce(response(finalTenant));
    const reads = jest.fn();
    const { qc } = fixture(<DependentProbe onRead={reads} />);
    await ready();
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(qc.getQueryState(["tenant-dependent"])?.fetchStatus).toBe("idle"),
    );
    expect(reads).toHaveBeenLastCalledWith(initialTenant?.id ?? null, true);
    const observedAtInvalidation: {
      ready: string | null | undefined;
      tenant: string | null | undefined;
    }[] = [];
    const invalidate = qc.invalidateQueries.bind(qc);
    jest.spyOn(qc, "invalidateQueries").mockImplementation((options) => {
      observedAtInvalidation.push({
        ready: screen.queryByTestId("ready")?.textContent,
        tenant: screen.queryByTestId("tenant")?.textContent,
      });
      return invalidate(options);
    });

    await act(async () => {
      if (method === "POST")
        await current.setActAs({ tenantId: TENANT.id, reason: TENANT.reason });
      else await current.clear();
    });

    await ready();
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    expect(reads).toHaveBeenLastCalledWith(finalTenant?.id ?? null, true);
    expect(observedAtInvalidation).toEqual([
      { ready: "true", tenant: finalTenant?.id ?? "none" },
    ]);
  },
);

it.each(["POST", "DELETE"])(
  "reconciles ambiguous %s failure with GET, rejects the original call, and never replays",
  async (method) => {
    const read = deferred();
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(response(method === "DELETE" ? TENANT : null))
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockReturnValueOnce(read.promise);
    fixture();
    await ready();
    let result!: Promise<unknown>;
    await act(async () => {
      result = (
        method === "POST"
          ? current.setActAs({ tenantId: TENANT.id, reason: TENANT.reason })
          : current.clear()
      ).catch((error: unknown) => error);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    blocked();
    await act(async () => {
      read.resolve(response(method === "POST" ? TENANT : null));
    });
    expect(await result).toEqual(new Error("Response lost"));
    await ready();
    expect(current.actingTenant).toEqual(method === "POST" ? TENANT : null);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      method,
      "GET",
    ]);
  },
);

it("stays blocked when mutation reconciliation also fails", async () => {
  const fetchMock = jest
    .spyOn(global, "fetch")
    .mockResolvedValueOnce(response(TENANT))
    .mockRejectedValueOnce(new Error("Delete uncertain"))
    .mockRejectedValueOnce(new Error("Read unavailable"));
  fixture();
  await ready();
  await act(async () => {
    await expect(current.clear()).rejects.toThrow("Delete uncertain");
  });
  await waitFor(() => expect(current.status).toBe("error"));
  blocked();
  await act(async () => {
    await expect(current.clear()).rejects.toThrow();
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("rejects synchronous duplicate mutations", async () => {
  const write = deferred();
  const fetchMock = jest
    .spyOn(global, "fetch")
    .mockResolvedValueOnce(response())
    .mockReturnValueOnce(write.promise);
  fixture();
  await ready();
  let first!: Promise<void>;
  await act(async () => {
    first = current.setActAs({ tenantId: TENANT.id, reason: TENANT.reason });
    await expect(current.clear()).rejects.toThrow();
  });
  await act(async () => {
    write.resolve(response(TENANT));
    await first;
  });
  expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
    "GET",
    "POST",
  ]);
});

it.each(["POST", "DELETE"])(
  "does not publish an old session's late %s completion into a new session",
  async (method) => {
    const write = deferred();
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(response(method === "DELETE" ? TENANT : null))
      .mockReturnValueOnce(write.promise)
      .mockResolvedValueOnce(response());
    const view = fixture();
    await ready();
    let result!: Promise<unknown>;
    await act(async () => {
      result = (
        method === "POST"
          ? current.setActAs({ tenantId: TENANT.id, reason: TENANT.reason })
          : current.clear()
      ).catch((error: unknown) => error);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    mockAuth.sessionRevision += 1;
    view.rerender();
    await ready();
    const scope = current.scopeKey;
    await act(async () => {
      write.resolve(response(method === "POST" ? TENANT : null));
    });
    expect(await result).toBeInstanceOf(Error);
    expect(current.scopeKey).toBe(scope);
    expect(current.actingTenant).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  },
);

it.each(["POST", "DELETE"])(
  "cancels a racing GET so it cannot overwrite the %s result",
  async (method) => {
    const staleRead = deferred();
    const write = deferred();
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(response(method === "DELETE" ? TENANT : null))
      .mockReturnValueOnce(write.promise)
      .mockReturnValueOnce(staleRead.promise);
    const { qc } = fixture();
    await ready();
    const key = qc
      .getQueryCache()
      .findAll({ queryKey: ["acting-tenant"] })[0].queryKey;
    let canceledRead!: Promise<unknown>;
    let pendingWrite!: Promise<void>;
    await act(async () => {
      pendingWrite =
        method === "POST"
          ? current.setActAs({ tenantId: TENANT.id, reason: TENANT.reason })
          : current.clear();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      canceledRead = qc
        .fetchQuery({
          queryKey: key,
          queryFn: async ({ signal }) => {
            const result = await fetch("/api/act-as", {
              method: "GET",
              signal,
            });
            return (await result.json()).actingTenant;
          },
          staleTime: 0,
        })
        .catch((error: unknown) => error);
      write.resolve(response(method === "POST" ? TENANT : null));
      await pendingWrite;
    });
    await ready();
    const scope = current.scopeKey;
    await act(async () => {
      staleRead.resolve(response(method === "DELETE" ? TENANT : null));
      await canceledRead;
    });
    expect(current.scopeKey).toBe(scope);
    expect(current.actingTenant).toEqual(method === "POST" ? TENANT : null);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      method,
      "GET",
    ]);
    expect(fetchMock.mock.calls[2][1]?.signal?.aborted).toBe(true);
  },
);

it.each(["POST", "DELETE"])(
  "rejects a retained %s callback while a newer GET is unresolved",
  async (method) => {
    const read = deferred();
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(response(TENANT))
      .mockReturnValueOnce(read.promise);
    const { qc } = fixture();
    await ready();
    const saved = current;
    const key = qc
      .getQueryCache()
      .findAll({ queryKey: ["acting-tenant"] })[0].queryKey;
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = qc.refetchQueries({ queryKey: ["acting-tenant"] });
      expect(qc.getQueryState(key)?.fetchStatus).toBe("fetching");
      expect(saved.isScopeCurrent(saved.scopeKey!)).toBe(false);
      const rejected =
        method === "POST"
          ? saved.setActAs({ tenantId: TENANT.id, reason: TENANT.reason })
          : saved.clear();
      await expect(rejected).rejects.toThrow("Tenant scope is not ready");
    });
    await waitFor(blocked);
    expect(qc.getQueryState(key)?.fetchStatus).toBe("fetching");
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "GET",
    ]);
    await act(async () => {
      read.resolve(response());
      await refresh;
    });
    await ready();
  },
);

it("rejects duplicate read retries without making an extra GET", async () => {
  const read = deferred();
  const fetchMock = jest
    .spyOn(global, "fetch")
    .mockRejectedValueOnce(new Error("Offline"))
    .mockReturnValueOnce(read.promise);
  fixture();
  await waitFor(() => expect(current.status).toBe("error"));
  let first!: Promise<void>;
  await act(async () => {
    first = current.retry();
    await expect(current.retry()).rejects.toThrow();
  });
  await act(async () => {
    read.resolve(response());
    await first;
  });
  await ready();
  expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
    "GET",
    "GET",
  ]);
});

it("discards a late read retry after the authentication session changes", async () => {
  const oldRead = deferred();
  const fetchMock = jest
    .spyOn(global, "fetch")
    .mockRejectedValueOnce(new Error("Offline"))
    .mockReturnValueOnce(oldRead.promise)
    .mockResolvedValueOnce(response());
  const view = fixture();
  await waitFor(() => expect(current.status).toBe("error"));
  let result!: Promise<unknown>;
  await act(async () => {
    result = current.retry().catch((error: unknown) => error);
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  mockAuth.sessionRevision += 1;
  view.rerender();
  await ready();
  const scope = current.scopeKey;
  await act(async () => {
    oldRead.resolve(response(TENANT));
  });
  expect(await result).toBeInstanceOf(Error);
  expect(current.scopeKey).toBe(scope);
  expect(current.actingTenant).toBeNull();
});

it.each([
  ["Save gateway config", upsertPaymentGatewayConfig],
  ["Save SMS config", upsertSmsConfig],
  ["Register template", registerSmsTemplate],
])(
  "rejects a retained %s submit in the event turn that begins a tenant switch",
  async (label, mutation) => {
    const write = deferred();
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(response())
      .mockReturnValueOnce(write.promise);
    fixture(<ProviderForms />);
    await ready();
    const form = screen.getByRole("button", { name: label }).closest("form")!;
    let switchRequest!: Promise<void>;
    await act(async () => {
      switchRequest = current.setActAs({
        tenantId: TENANT.id,
        reason: TENANT.reason,
      });
      fireEvent.submit(form);
      await Promise.resolve();
    });
    expect(mutation).not.toHaveBeenCalled();
    await act(async () => {
      write.resolve(response(TENANT));
      await switchRequest;
    });
    await ready();
  },
);

it("validates a captured scope against the live operation and resolved tenant", async () => {
  const write = deferred();
  jest
    .spyOn(global, "fetch")
    .mockResolvedValueOnce(response())
    .mockReturnValueOnce(write.promise);
  fixture();
  await ready();
  const saved = current;
  const ownScope = current.scopeKey!;
  expect(saved.isScopeCurrent(ownScope)).toBe(true);
  expect(saved.isScopeCurrent("unrelated-scope")).toBe(false);
  let switchRequest!: Promise<void>;
  await act(async () => {
    switchRequest = current.setActAs({
      tenantId: TENANT.id,
      reason: TENANT.reason,
    });
    expect(saved.isScopeCurrent(ownScope)).toBe(false);
  });
  await act(async () => {
    write.resolve(response(TENANT));
    await switchRequest;
  });
  await ready();
  expect(saved.isScopeCurrent(ownScope)).toBe(false);
  expect(current.isScopeCurrent(current.scopeKey!)).toBe(true);
});

it.each(["POST", "DELETE"])(
  "rejects a retained %s callback after a completed tenant switch",
  async (method) => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(TENANT))
      .mockResolvedValue(response(method === "POST" ? TENANT : null));
    fixture();
    await ready();
    const saved = current;
    await act(async () => {
      await current.setActAs({ tenantId: TENANT.id, reason: TENANT.reason });
    });
    await ready();
    await act(async () => {
      await expect(
        method === "POST"
          ? saved.setActAs({ tenantId: TENANT.id, reason: TENANT.reason })
          : saved.clear(),
      ).rejects.toThrow("Tenant scope is not ready");
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "POST",
    ]);
  },
);

it("does not claim readiness while a background scope read is paused", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue(response(TENANT));
  const { qc } = fixture();
  await ready();
  await act(async () => {
    onlineManager.setOnline(false);
    await qc.refetchQueries({ queryKey: ["acting-tenant"] });
  });
  expect(
    qc.getQueryCache().findAll({ queryKey: ["acting-tenant"] })[0].state
      .fetchStatus,
  ).toBe("paused");
  await waitFor(blocked);
});

it.each([
  ["Save gateway config", upsertPaymentGatewayConfig],
  ["Save SMS config", upsertSmsConfig],
  ["Register template", registerSmsTemplate],
])(
  "blocks a queued %s mutation when switching starts before its execution",
  async (label, mutation) => {
    const write = deferred();
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(response())
      .mockReturnValueOnce(write.promise);
    fixture(<ProviderForms />);
    await ready();
    const form = screen.getByRole("button", { name: label }).closest("form")!;
    let switchRequest!: Promise<void>;
    await act(async () => {
      fireEvent.submit(form);
      switchRequest = current.setActAs({
        tenantId: TENANT.id,
        reason: TENANT.reason,
      });
      await Promise.resolve();
    });
    expect(mutation).not.toHaveBeenCalled();
    await act(async () => {
      write.resolve(response(TENANT));
      await switchRequest;
    });
    await ready();
  },
);
