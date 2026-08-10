import {
  buildReportFilename,
  buildReportQueryParams,
  REPORT_CONFIGS,
} from "@/app/(with-auth)/dashboard/report-builder/page";

describe("report-builder endpoint contracts", () => {
  test.each([
    ["users", 100],
    ["appointments", 100],
  ] as const)("%s stays within its enforced backend limit", (reportType, limit) => {
    expect(REPORT_CONFIGS[reportType].maxRows).toBe(limit);
  });

  test.each(Object.keys(REPORT_CONFIGS) as Array<keyof typeof REPORT_CONFIGS>)(
    "%s does not advertise an unsupported date range",
    (reportType) => {
      const config = REPORT_CONFIGS[reportType];
      const query = buildReportQueryParams(config, "2026-07-01", "2026-07-31");

      expect(config.supportsDateRange).toBe(false);
      expect(query).toBe(`limit=${config.maxRows}`);
      expect(query).not.toContain("startDate");
      expect(query).not.toContain("endDate");
    },
  );

  test("unsupported ranges are not embedded in export filenames", () => {
    expect(
      buildReportFilename(
        "pharmacy",
        REPORT_CONFIGS.pharmacy,
        "2026-07-01",
        "2026-07-31",
      ),
    ).toBe("pharmacy-report-latest-500.csv");
  });
});
