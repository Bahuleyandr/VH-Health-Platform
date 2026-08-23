import EncryptionKeysPage from "@/app/(with-auth)/dashboard/encryption-keys/page";
import {
  listEncryptionKeys,
  markEncryptionKeyCompromised,
  registerEncryptionKey,
  retireEncryptionKey,
  rotateEncryptionKey,
} from "@/lib/api/encryptionKeys";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

const ACTIVE_KEY = {
  id: 3,
  tenant_id: "35353535-3535-4353-8535-353535353503",
  key_id: "tenant-kek-v2",
  provider: "vault" as const,
  provider_reference: "transit/keys/tenant-kek-v2",
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
  key_id: "tenant-kek-v1",
  provider_reference: "transit/keys/tenant-kek-v1",
  status: "retiring" as const,
  rotated_from: null,
  activated_at: "2026-06-01T10:00:00.000Z",
  retiring_at: "2026-08-01T10:00:00.000Z",
};

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

describe("<EncryptionKeysPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listEncryptionKeys as jest.Mock).mockResolvedValue({
      keys: [ACTIVE_KEY, RETIRING_KEY],
      count: 2,
    });
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

  it("lists keys with statuses and marks the newest active key as the write key", async () => {
    renderPage();

    await screen.findByText("tenant-kek-v2");
    expect(screen.getByText("tenant-kek-v1")).toBeInTheDocument();
    // Only the newest active key carries the write marker.
    expect(screen.getAllByText("Active — new writes")).toHaveLength(1);
    // Retiring keys can still be retired, active keys too — one Retire per row.
    expect(screen.getAllByRole("button", { name: "Retire" })).toHaveLength(2);
    expect(listEncryptionKeys).toHaveBeenCalled();
  });

  it("requires the typed key id + reason before firing mark-compromised, restating the consequence", async () => {
    renderPage();
    await screen.findByText("tenant-kek-v2");

    // Row action for the active key opens the confirm dialog.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Mark compromised" })[0],
    );

    // The dialog restates the consequence verbatim.
    expect(
      await screen.findByText(/Decryption paths move off this key immediately/),
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
      target: { value: "tenant-kek-v2" },
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

  it("retires a key only after the key id is typed back", async () => {
    renderPage();
    await screen.findByText("tenant-kek-v1");

    // Second Retire button belongs to the retiring key row.
    fireEvent.click(screen.getAllByRole("button", { name: "Retire" })[1]);

    const confirmButton = await screen.findByRole("button", {
      name: "Confirm retire",
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type the key id/), {
      target: { value: "tenant-kek-v1" },
    });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(retireEncryptionKey).toHaveBeenCalledWith(2));
  });
});
