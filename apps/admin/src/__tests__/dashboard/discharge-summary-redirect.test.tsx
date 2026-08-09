import LegacyDischargeSummaryRedirect from "@/app/(with-auth)/dashboard/discharge-summary/page";

const mockPermanentRedirect = jest.fn();

jest.mock("next/navigation", () => ({
  permanentRedirect: (...args: unknown[]) => mockPermanentRedirect(...args),
}));

describe("legacy discharge summary route", () => {
  beforeEach(() => {
    mockPermanentRedirect.mockReset();
  });

  it("permanently redirects to the maintained discharge summary builder", () => {
    LegacyDischargeSummaryRedirect();

    expect(mockPermanentRedirect).toHaveBeenCalledWith(
      "/dashboard/discharge-summaries",
    );
  });
});
