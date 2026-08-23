import EncryptionKeysPage from "@/app/(with-auth)/dashboard/encryption-keys/page";
import {
  listEncryptionKeys,
  markEncryptionKeyCompromised,
  registerEncryptionKey,
  retireEncryptionKey,
  rotateEncryptionKey,
} from "@/lib/api/encryptionKeys";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { toast } from "react-hot-toast";

jest.mock("@/lib/api/encryptionKeys", () => {
  const actual = jest.requireActual("@/lib/api/encryptionKeys");
  return {
    ...actual,
    listEncryptionKeys: jest.fn(),
    markEncryptionKeyCompromised: jest.fn(),
    registerEncryptionKey: jest.fn(),
    retireEncryptionKey: jest.fn(),
    rotateEncryptionKey: jest.fn(),
  };
});

jest.mock("react-hot-toast", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

// Shapes below mirror the backend RETURNING list in
// services/security/encryptionKeyRegistryService.js. They are deliberately
// registry-managed rows — a KMS provider, no material of their own, and a
// key_id outside the reserved `t:<tenantId>:v<n>` namespace — because the list
// endpoint puts live-material rows in `protected`, never in `keys`.
const ACTIVE_KEY = {
  id: 3,
  tenant_id: "35353535-3535-4353-8535-353535353503",
  key_id: "phi-kek-v2",
  provider: "vault" as const,
  provider_reference: "transit/keys/phi-kek-v2",
  algorithm: "aes-256-gcm",
  status: "active" as const,
  rotated_from: 2,
  activated_at: "2026-08-01T10:00:00.000Z",
  retiring_at: null,
  retired_at: null,
  metadata: {},
  created_by: null,
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-01T10:00:00.000Z",
};

const RETIRING_KEY = {
  ...ACTIVE_KEY,
  id: 2,
  key_id: "phi-kek-v1",
  provider_reference: "transit/keys/phi-kek-v1",
  status: "retiring" as const,
  rotated_from: null,
  activated_at: "2026-06-01T10:00:00.000Z",
  retiring_at: "2026-08-01T10:00:00.000Z",
};

// A second active entry. `listEncryptionKeys` orders activated_at DESC, so this
// one is older than ACTIVE_KEY and would have lost the round-1 badge race.
const OLDER_ACTIVE_KEY = {
  ...ACTIVE_KEY,
  id: 1,
  key_id: "archive-kek-v1",
  provider_reference: "transit/keys/archive-kek-v1",
  rotated_from: null,
  activated_at: "2026-05-01T10:00:00.000Z",
};

// The `protected` half of the list response: exactly the seven fields the
// service puts there, with the class it landed in and the marker that put it
// there. The client used to type the response as `{ keys, count }` and discard
// this, so the "nothing is dropped" promise was invisible to an operator.
const WITHHELD_LIVE_KEK = {
  id: 9,
  tenant_id: "35353535-3535-4353-8535-353535353503",
  key_id: "t:35353535-3535-4353-8535-353535353503:v4",
  provider: "local-tenant",
  status: "active",
  key_class: "live_key_material" as const,
  reason:
    "provider 'local-tenant'; a key id inside its own tenant's reserved t:<tenantId>:v<n> namespace",
};

const WITHHELD_SIGNING_KEY = {
  id: 11,
  tenant_id: "35353535-3535-4353-8535-353535353503",
  key_id: "cc-pack-signing-2026",
  provider: "env",
  status: "active",
  key_class: "signing_key" as const,
  reason: "metadata.purpose 'clinical_continuity_pack_signing'",
};

function listResponse(
  keys: unknown[],
  withheld: unknown[] = [WITHHELD_LIVE_KEK],
) {
  return {
    keys,
    count: keys.length,
    protected: withheld,
    protected_count: withheld.length,
  };
}

/** An error shaped the way core.ts throws one: message + the error envelope. */
function apiRefusal(
  message: string,
  code: string,
  details?: Record<string, unknown>,
) {
  return Object.assign(new Error(message), {
    name: "APIError",
    status: 400,
    data: { success: false, message, code, details },
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EncryptionKeysPage />
    </QueryClientProvider>,
  );
}

/** The whole amber callout, with JSX line-wrapping whitespace normalised. */
function bannerText() {
  const banner = screen
    .getByText("This page is not the whole key store.")
    .closest("div");
  return (banner?.textContent ?? "").replace(/\s+/g, " ");
}

describe("<EncryptionKeysPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listEncryptionKeys as jest.Mock).mockResolvedValue(
      listResponse([ACTIVE_KEY, RETIRING_KEY]),
    );
    (markEncryptionKeyCompromised as jest.Mock).mockResolvedValue({
      ...ACTIVE_KEY,
      status: "compromised",
    });
    (retireEncryptionKey as jest.Mock).mockResolvedValue({
      ...RETIRING_KEY,
      status: "retired",
    });
    (registerEncryptionKey as jest.Mock).mockResolvedValue(ACTIVE_KEY);
    (rotateEncryptionKey as jest.Mock).mockResolvedValue(ACTIVE_KEY);
  });

  it("lists entries with their registry status", async () => {
    renderPage();

    await screen.findByText("phi-kek-v2");
    expect(screen.getByText("phi-kek-v1")).toBeInTheDocument();
    // Retiring entries can still be retired, active ones too — one per row.
    expect(screen.getAllByRole("button", { name: "Retire" })).toHaveLength(2);
    expect(listEncryptionKeys).toHaveBeenCalled();
  });

  it("does not claim any listed entry is the key receiving writes", async () => {
    // Round 1 badged the newest listed status='active' row "Active — new
    // writes". The listing is fenced to registry entries and the response
    // carries no field naming the write key, so that claim can only ever land
    // on an inert row. No listed row may assert it — not even when several are
    // active at once.
    (listEncryptionKeys as jest.Mock).mockResolvedValue(
      listResponse([ACTIVE_KEY, OLDER_ACTIVE_KEY, RETIRING_KEY], []),
    );
    renderPage();

    await screen.findByText("phi-kek-v2");
    // Nothing was withheld in this fixture, so the entries table is the only
    // table on the page.
    const table = screen.getByRole("table");
    expect(within(table).queryByText(/new writes/i)).not.toBeInTheDocument();
    expect(
      within(table).queryByText(/writes|encrypting under/i),
    ).not.toBeInTheDocument();
    // The registry status itself is still shown, on both active entries.
    expect(within(table).getAllByText("active")).toHaveLength(2);
  });

  it("tells the operator this listing is not the whole key store", async () => {
    renderPage();
    await screen.findByText("phi-kek-v2");

    expect(
      screen.getByText("This page is not the whole key store."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/never re-encrypt or re-wrap a stored record/, {
        selector: "p",
      }),
    ).toBeInTheDocument();
    // Both server-side counts, side by side: what this console can act on, and
    // what the same response withheld from it.
    expect(screen.getByText("(2 listed · 1 withheld)")).toBeInTheDocument();
  });

  it("states the per-action truth instead of one blanket refusal claim", async () => {
    renderPage();
    await screen.findByText("phi-kek-v2");
    const text = bannerText();

    // The round-2 line. register refuses no protected row (it creates one), and
    // rotate refuses an operation rather than a named row, so this was false
    // for two of the four actions it named.
    expect(text).not.toMatch(
      /refuses register, rotate, retire and mark-compromised/i,
    );

    // retire + compromise: the two that refuse a NAMED row, 409 by class.
    expect(text).toMatch(
      /Retire and mark compromised name a row, so they refuse a withheld one outright \(409\) and report the class it landed in/,
    );
    // rotate: refuses the operation when the only active keys are undemotable.
    expect(text).toMatch(
      /Rotate names no row .* the rotation is refused rather than adding a new entry beside the key that is really active/,
    );
    // register: a mint-time invariant, not a refusal against an existing row.
    expect(text).toMatch(
      /Register has no existing row to protect, so it refuses up front any entry that would be created and then withheld on the next read/,
    );
  });

  it("names the rows the backend withheld instead of dropping them", async () => {
    (listEncryptionKeys as jest.Mock).mockResolvedValue(
      listResponse([ACTIVE_KEY], [WITHHELD_LIVE_KEK, WITHHELD_SIGNING_KEY]),
    );
    renderPage();
    await screen.findByText("phi-kek-v2");

    // The banner points at this section by name; the section has to exist.
    expect(
      screen.getByRole("heading", { name: "Withheld from this console" }),
    ).toBeInTheDocument();
    // Two tables now: the actionable entries, and the disclosure.
    const found = screen
      .getAllByRole("table")
      .find((t) => within(t).queryByText("Withheld as"));
    expect(found).toBeDefined();
    const withheldTable = found as HTMLElement;

    // Every withheld row is named, with its class and the marker that put it
    // there — that is the whole point of rendering `protected`.
    expect(
      within(withheldTable).getByText(
        "t:35353535-3535-4353-8535-353535353503:v4",
      ),
    ).toBeInTheDocument();
    expect(
      within(withheldTable).getByText("Live key material"),
    ).toBeInTheDocument();
    expect(
      within(withheldTable).getByText(/provider 'local-tenant'/),
    ).toBeInTheDocument();

    expect(
      within(withheldTable).getByText("cc-pack-signing-2026"),
    ).toBeInTheDocument();
    expect(within(withheldTable).getByText("Signing key")).toBeInTheDocument();
    expect(
      within(withheldTable).getByText(
        /metadata.purpose 'clinical_continuity_pack_signing'/,
      ),
    ).toBeInTheDocument();

    expect(screen.getByText("(1 listed · 2 withheld)")).toBeInTheDocument();
  });

  it("says so explicitly when nothing was withheld", async () => {
    (listEncryptionKeys as jest.Mock).mockResolvedValue(
      listResponse([ACTIVE_KEY], []),
    );
    renderPage();
    await screen.findByText("phi-kek-v2");

    expect(
      screen.getByText(/The backend withheld no row from this listing/),
    ).toBeInTheDocument();
    expect(screen.getByText("(1 listed · 0 withheld)")).toBeInTheDocument();
  });

  it("offers only algorithms the registry can manage, never free text", async () => {
    renderPage();
    await screen.findByText("phi-kek-v2");
    fireEvent.click(screen.getByRole("button", { name: "Register key" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Register new key",
    });

    const algorithm = within(dialog).getByLabelText("Algorithm");
    // Free text is what let an operator mint a row the fence then withheld
    // forever. The control is a fixed list now.
    expect(algorithm.tagName).toBe("SELECT");
    expect(
      Array.from((algorithm as HTMLSelectElement).options).map((o) => o.value),
    ).toEqual([
      "aes-256-gcm",
      "aes-192-gcm",
      "aes-128-gcm",
      "chacha20-poly1305",
    ]);
    expect(within(algorithm).queryByText(/ed25519/i)).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Key id"), {
      target: { value: "phi-kek-v3" },
    });
    fireEvent.change(algorithm, { target: { value: "aes-128-gcm" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Register key" }),
    );

    await waitFor(() =>
      expect(registerEncryptionKey).toHaveBeenCalledWith({
        key_id: "phi-kek-v3",
        provider: "env",
        provider_reference: null,
        algorithm: "aes-128-gcm",
      }),
    );
  });

  it("reports a mint-time refusal with its code instead of claiming success", async () => {
    // The backend now refuses a row it would create and then withhold. If one
    // still arrives — e.g. from a metadata marker this form does not set — the
    // dialog stays open, shows the message, and names the code.
    (registerEncryptionKey as jest.Mock).mockRejectedValue(
      apiRefusal(
        "Registering this key would create an encryption_keys row this console could never offer as actionable: signature algorithm 'Ed25519'.",
        "ENCRYPTION_KEY_WOULD_BE_UNMANAGEABLE",
        {
          key_id: "phi-kek-v3",
          key_class: "signing_key",
          reason: "signature algorithm 'Ed25519'",
        },
      ),
    );
    renderPage();
    await screen.findByText("phi-kek-v2");
    fireEvent.click(screen.getByRole("button", { name: "Register key" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Register new key",
    });
    fireEvent.change(within(dialog).getByLabelText("Key id"), {
      target: { value: "phi-kek-v3" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Register key" }),
    );

    expect(
      await screen.findByText(/could never offer as actionable/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ENCRYPTION_KEY_WOULD_BE_UNMANAGEABLE"),
    ).toBeInTheDocument();
    expect(screen.getByText("signing_key")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("does not call a bootstrap insert a rotation", async () => {
    // rotated_from is NULL only when there was no active key to demote — the
    // backend refuses instead of downgrading a blocked rotation to a first-key
    // insert, so nothing was retired here and the toast must not say otherwise.
    (rotateEncryptionKey as jest.Mock).mockResolvedValue({
      ...ACTIVE_KEY,
      key_id: "phi-kek-v3",
      rotated_from: null,
    });
    renderPage();
    await screen.findByText("phi-kek-v2");
    fireEvent.click(screen.getByRole("button", { name: "Rotate active key" }));
    fireEvent.change(await screen.findByLabelText("New key id"), {
      target: { value: "phi-kek-v3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rotate now" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "New key registered as active — there was no active entry to retire",
      ),
    );
  });

  it("reports a real rotation as one", async () => {
    (rotateEncryptionKey as jest.Mock).mockResolvedValue({
      ...ACTIVE_KEY,
      key_id: "phi-kek-v3",
      rotated_from: 3,
    });
    renderPage();
    await screen.findByText("phi-kek-v2");
    fireEvent.click(screen.getByRole("button", { name: "Rotate active key" }));
    fireEvent.change(await screen.findByLabelText("New key id"), {
      target: { value: "phi-kek-v3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rotate now" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Key rotated — the previous entry is now retiring",
      ),
    );
  });

  it("requires the typed key id + reason before firing mark-compromised, restating the consequence", async () => {
    renderPage();
    await screen.findByText("phi-kek-v2");

    // Row action for the first entry opens the confirm dialog.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Mark compromised" })[0],
    );

    // The dialog states what the action actually does.
    expect(
      await screen.findByText(
        "This stamps an incident record on the registry entry.",
      ),
    ).toBeInTheDocument();

    const confirmButton = screen.getByRole("button", {
      name: "Confirm compromise",
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: "KMS provider reported unauthorized access" },
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type the key id/), {
      target: { value: "phi-kek-v2" },
    });
    expect(confirmButton).not.toBeDisabled();

    fireEvent.click(confirmButton);
    await waitFor(() =>
      expect(markEncryptionKeyCompromised).toHaveBeenCalledWith(
        3,
        "KMS provider reported unauthorized access",
      ),
    );
  });

  it("retires an entry only after the key id is typed back", async () => {
    renderPage();
    await screen.findByText("phi-kek-v1");

    // Second Retire button belongs to the retiring entry's row.
    fireEvent.click(screen.getAllByRole("button", { name: "Retire" })[1]);

    const confirmButton = await screen.findByRole("button", {
      name: "Confirm retire",
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type the key id/), {
      target: { value: "phi-kek-v1" },
    });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(retireEncryptionKey).toHaveBeenCalledWith(2));
  });

  it("shows the backend's refusal verbatim when an action is rejected", async () => {
    // The class fence refuses retire/compromise server-side; core.ts surfaces
    // the envelope `message`, and the dialog renders it unchanged.
    (retireEncryptionKey as jest.Mock).mockRejectedValue(
      Object.assign(
        new Error(
          "Encryption key 't:35353535-3535-4353-8535-353535353503:v4' belongs to the per-tenant envelope KEK lifecycle, not this registry",
        ),
        {
          status: 409,
          data: {
            success: false,
            code: "ENCRYPTION_KEY_LIVE_MATERIAL",
            details: {
              key_class: "live_key_material",
              reason: "provider 'local-tenant'",
            },
          },
        },
      ),
    );
    renderPage();
    await screen.findByText("phi-kek-v1");

    fireEvent.click(screen.getAllByRole("button", { name: "Retire" })[1]);
    fireEvent.change(await screen.findByLabelText(/Type the key id/), {
      target: { value: "phi-kek-v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm retire" }));

    expect(
      await screen.findByText(/belongs to the per-tenant envelope KEK/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ENCRYPTION_KEY_LIVE_MATERIAL"),
    ).toBeInTheDocument();
    expect(screen.getByText("live_key_material")).toBeInTheDocument();
  });

  it("does not label an ordinary failure a fence refusal", async () => {
    // A transport failure or a plain duplicate-key 409 carries no fence code.
    // The message is still shown; the fence line must not be.
    (retireEncryptionKey as jest.Mock).mockRejectedValue(
      new Error("API Error: 500"),
    );
    renderPage();
    await screen.findByText("phi-kek-v1");

    fireEvent.click(screen.getAllByRole("button", { name: "Retire" })[1]);
    fireEvent.change(await screen.findByLabelText(/Type the key id/), {
      target: { value: "phi-kek-v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm retire" }));

    expect(await screen.findByText("API Error: 500")).toBeInTheDocument();
    expect(
      screen.queryByText(/Refused by the backend registry fence/),
    ).not.toBeInTheDocument();
  });
});
