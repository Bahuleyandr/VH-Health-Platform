import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import ContinuityFacilityContextPage from "@/app/(with-auth)/dashboard/continuity-facility-context/page";
import { usePermissions } from "@/hooks/usePermissions";
import { APIError } from "@/lib/api/core";
import {
  CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE,
  enrollContinuityFacilityGrant,
  listContinuityFacilityGrants,
  revokeContinuityFacilityGrant,
} from "@/lib/api/continuityFacilityContext";

jest.mock("@/hooks/usePermissions", () => ({ usePermissions: jest.fn() }));
jest.mock("@/lib/api/continuityFacilityContext", () => {
  const actual = jest.requireActual("@/lib/api/continuityFacilityContext");
  return {
    ...actual,
    listContinuityFacilityGrants: jest.fn(),
    enrollContinuityFacilityGrant: jest.fn(),
    revokeContinuityFacilityGrant: jest.fn(),
  };
});

const mockList = listContinuityFacilityGrants as jest.MockedFunction<
  typeof listContinuityFacilityGrants
>;

function setRole(role: "ADMIN" | "SUPER_ADMIN") {
  (usePermissions as jest.Mock).mockReturnValue({
    role,
    loading: false,
  } as unknown as ReturnType<typeof usePermissions>);
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ContinuityFacilityContextPage />
    </QueryClientProvider>,
  );
}

describe("<ContinuityFacilityContextPage /> inert posture", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setRole("SUPER_ADMIN");
  });

  it("renders the real typed 503 state and sends no mutation", async () => {
    mockList.mockRejectedValueOnce(
      new APIError(
        "Clinical continuity facility enrollment is unavailable",
        503,
        {
          success: false,
          message: "Clinical continuity facility enrollment is unavailable",
          requestId: "req-page-503",
          code: CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE,
        },
      ),
    );

    renderPage();

    expect(await screen.findByText("Not yet activated")).toBeInTheDocument();
    expect(
      screen.getByText(CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE),
    ).toBeInTheDocument();
    expect(screen.getByText(/req-page-503/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open device-loss operator runbook" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enroll fixed device" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Issue exact staff\/device grant/ }),
    ).not.toBeInTheDocument();
    expect(enrollContinuityFacilityGrant).not.toHaveBeenCalled();
    expect(revokeContinuityFacilityGrant).not.toHaveBeenCalled();
  });

  it("renders a 403 denial without controls", async () => {
    mockList.mockRejectedValueOnce(
      new APIError("Forbidden", 403, {
        success: false,
        message: "Only integration admins can manage devices",
        requestId: "req-page-403",
      }),
    );

    renderPage();

    expect(await screen.findByText("Denied")).toBeInTheDocument();
    expect(screen.getByText(/req-page-403/)).toBeInTheDocument();
    expect(enrollContinuityFacilityGrant).not.toHaveBeenCalled();
    expect(revokeContinuityFacilityGrant).not.toHaveBeenCalled();
  });

  it("renders network failure as service unavailable with retry only", async () => {
    mockList.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    renderPage();

    expect(await screen.findByText("Service unavailable")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry server check" }),
    ).toBeInTheDocument();
    expect(enrollContinuityFacilityGrant).not.toHaveBeenCalled();
    expect(revokeContinuityFacilityGrant).not.toHaveBeenCalled();
  });

  it("does not call the endpoint for an ordinary ADMIN", async () => {
    setRole("ADMIN");

    renderPage();

    expect(screen.getByText("SUPER_ADMIN access required")).toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
  });
});
