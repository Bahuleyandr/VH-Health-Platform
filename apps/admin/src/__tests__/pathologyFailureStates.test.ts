import fs from "node:fs";
import path from "node:path";

describe("pathology workflow failure states", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/app/(with-auth)/dashboard/pathology/page.tsx"),
    "utf8",
  );

  it("does not render failed worklist or TAT queries as authoritative empty state", () => {
    expect(source).toContain("worklist.isError");
    expect(source).toContain("!worklist.isError && (worklist.data ?? []).length === 0");
    expect(source).toContain("tatMetrics.isError");
    expect(source).toContain("!tatMetrics.isError && (tatMetrics.data ?? []).length === 0");
  });

  it("surfaces accession, detail, and every workflow mutation failure", () => {
    expect(source).toContain("accessionMutation.error");
    expect(source).toContain("detailError={detail.error}");
    for (const mutation of [
      "grossMutation.error",
      "blockMutation.error",
      "slideMutation.error",
      "reportMutation.error",
      "signMutation.error",
      "addendumMutation.error",
      "releaseHoldMutation.error",
      "releaseNowMutation.error",
    ]) {
      expect(source).toContain(mutation);
    }
    expect(source.match(/role="alert"/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
