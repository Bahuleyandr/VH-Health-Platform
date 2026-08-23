import { AdmissionIntakeTab } from "@/app/(with-auth)/dashboard/insurance/components/AdmissionIntakeTab";
import { fetchAdminAPI } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

jest.mock("@/lib/api", () => ({
  fetchAdminAPI: jest.fn(),
}));

const mockedFetchAdminAPI = fetchAdminAPI as jest.MockedFunction<typeof fetchAdminAPI>;

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("<AdmissionIntakeTab />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchAdminAPI.mockImplementation(async (endpoint, init) => {
      if (!init && endpoint === "/emr/admissions?limit=50") {
        return [
          {
            id: 42,
            patient_uid: "11111111-1111-4111-8111-111111111111",
            patient_name: "Asha Rao",
            ward: "Ward A",
            bed_number: "A-101",
            admitting_diagnosis: "Acute cholecystitis",
            chief_complaint: "Pain abdomen",
            admitted_at: "2026-05-18T08:00:00Z",
            expected_los_days: 3,
            status: "admitted",
          },
        ] as never;
      }
      if (!init && endpoint === "/insurance/packages?status=active") {
        return [] as never;
      }
      if (!init && endpoint === "/emr/admission/42") {
        return {
          admission: {
            id: 42,
            patient_uid: "11111111-1111-4111-8111-111111111111",
            patient_name: "Asha Rao",
            ward: "Ward A",
            bed_number: "A-101",
            admitting_diagnosis: "Acute cholecystitis",
            chief_complaint: "Pain abdomen",
            admitted_at: "2026-05-18T08:00:00Z",
            expected_los_days: 3,
            status: "admitted",
          },
        } as never;
      }
      if (endpoint === "/insurance/policies" && init?.method === "POST") {
        return {
          id: 7,
          patient_uid: "11111111-1111-4111-8111-111111111111",
          payer_id: null,
          tpa_id: null,
          payer_name: "Star Health",
          tpa_name: "Medi Assist",
          policy_number: "POL-42",
          member_id: null,
          policyholder_name: null,
          policy_type: "cashless",
          sum_insured: null,
          cumulative_used: null,
          valid_from: null,
          valid_to: null,
          status: "active",
        } as never;
      }
      if (endpoint === "/insurance/preauth" && init?.method === "POST") {
        return {
          id: 9,
          preauth_number: "PA-2627-00009",
          patient_uid: "11111111-1111-4111-8111-111111111111",
          policy_number: "POL-42",
          payer_name: "Star Health",
          tpa_name: "Medi Assist",
          primary_diagnosis: "Acute cholecystitis",
          expected_cost: 65000,
          sanctioned_amount: null,
          status: "draft",
          submitted_at: null,
          created_at: "2026-05-18T08:05:00Z",
        } as never;
      }
      if (endpoint === "/insurance/preauth/9/submit" && init?.method === "POST") {
        return {
          id: 9,
          preauth_number: "PA-2627-00009",
          patient_uid: "11111111-1111-4111-8111-111111111111",
          policy_number: "POL-42",
          payer_name: "Star Health",
          tpa_name: "Medi Assist",
          primary_diagnosis: "Acute cholecystitis",
          expected_cost: 65000,
          sanctioned_amount: null,
          status: "submitted",
          submitted_at: "2026-05-18T08:06:00Z",
          created_at: "2026-05-18T08:05:00Z",
        } as never;
      }
      return [] as never;
    });
  });

  it("creates a policy and admission-linked pre-auth, then submits the packet", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AdmissionIntakeTab />);

    await user.type(screen.getByLabelText("Admission ID"), "42");
    await user.click(screen.getByRole("button", { name: "Load admission" }));

    await screen.findByText("Asha Rao");
    await user.type(screen.getByLabelText("Insurer"), "Star Health");
    await user.type(screen.getByLabelText("TPA"), "Medi Assist");
    await user.type(screen.getByLabelText("Policy number *"), "POL-42");
    await user.clear(screen.getByLabelText("Expected cost *"));
    await user.type(screen.getByLabelText("Expected cost *"), "65000");

    await user.click(screen.getByRole("button", { name: "Create and submit pre-auth" }));

    await waitFor(() => {
      expect(mockedFetchAdminAPI).toHaveBeenCalledWith(
        "/insurance/policies",
        expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({
            patient_uid: "11111111-1111-4111-8111-111111111111",
            insurer_name: "Star Health",
            tpa_name: "Medi Assist",
            policy_number: "POL-42",
          }),
        }),
      );
    });
    expect(mockedFetchAdminAPI).toHaveBeenCalledWith(
      "/insurance/preauth",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          policy_id: 7,
          admission_id: 42,
          patient_uid: "11111111-1111-4111-8111-111111111111",
          primary_diagnosis: "Acute cholecystitis",
          expected_cost: 65000,
        }),
      }),
    );
    expect(mockedFetchAdminAPI).toHaveBeenCalledWith(
      "/insurance/preauth/9/submit",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText("Submitted: PA-2627-00009")).toBeInTheDocument();
  });
});
