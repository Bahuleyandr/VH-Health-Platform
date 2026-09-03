// The MAR round is the caller that makes the BCMA wristband producer reachable
// from a browser. Before this control the printable band existed on the backend
// but no client linked to it, and the proxy prefix that carries it
// (api/v1/bcma) was added alongside this link in the same lane.
//
// Reachable by whom is the backend's call, not this page's: the wristband route
// requires a care relationship to the patient, so bedside nursing and treating
// clinicians get the band and an unrelated staff role gets a 403 — with ADMIN
// and SUPER_ADMIN admitted without break-glass and audited as administrative
// access (owner decision 2026-08-25). This suite therefore pins the URL the
// control emits, not an authorization outcome — see src/lib/bcmaWristband.ts
// and apps/backend/src/routes/clinical/bcmaRoutes.js.

import MarPage from "@/app/(with-auth)/dashboard/mar/page";
import { fetchAdminAPI } from "@/lib/api";
import { printableWristbandUrl } from "@/lib/bcmaWristband";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn(),
}));

// MarPage reads usePermissions to decide whether it may enumerate the due list
// (OPEN-11 — see mar-due-list-gate.test.tsx). The real hook needs an
// AuthProvider, and this suite pins the wristband URL rather than any
// authorization outcome, so it mounts as a bedside nursing role: that is the
// identity whose due list actually populates, which is what gives these tests
// their dose rows to assert links on.
jest.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ rawRole: "NURSING_STAFF" }),
}));

const fetchAdminAPIMock = fetchAdminAPI as jest.MockedFunction<
  typeof fetchAdminAPI
>;

const PATIENT_UID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

const DUE_DOSE = {
  id: 501,
  patient_uid: PATIENT_UID,
  prescription_id: 9,
  medication_name: "Amoxicillin",
  dose: "500 mg",
  dosage: null,
  route: "PO",
  scheduled_time: "2026-08-24T09:00:00.000Z",
  status: "scheduled",
  administered_at: null,
  notes: null,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MarPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchAdminAPIMock.mockImplementation(async (endpoint: string) =>
    endpoint.includes("/mar/due") ? { data: [DUE_DOSE] } : { data: [] },
  );
});

describe("MAR round — Print band", () => {
  it("links each due dose to the printable wristband for that patient", async () => {
    renderPage();

    const link = (
      await screen.findAllByRole("link", {
        name: "Print band",
      })
    )[0];
    expect(link).toHaveAttribute("href", printableWristbandUrl(PATIENT_UID));
    // A new tab, and never a window that can reach back into the portal.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("offers the same link beside the 5-rights patient-scan field", async () => {
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "Administer →" }),
    );
    await screen.findByText("5-Rights Check");

    // One in the dose row, one in the modal — both for this patient.
    const links = screen.getAllByRole("link", { name: "Print band" });
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect(link).toHaveAttribute("href", printableWristbandUrl(PATIENT_UID));
    }
  });

  it("renders no control when the row carries something that is not a patient UUID", async () => {
    fetchAdminAPIMock.mockImplementation(async (endpoint: string) =>
      endpoint.includes("/mar/due")
        ? { data: [{ ...DUE_DOSE, patient_uid: "legacy-local-id" }] }
        : { data: [] },
    );
    renderPage();

    await screen.findByText("Amoxicillin");
    expect(screen.queryByRole("link", { name: "Print band" })).toBeNull();
  });
});
