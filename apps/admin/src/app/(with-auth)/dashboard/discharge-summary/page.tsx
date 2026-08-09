// Legacy route — the old single-admission discharge summary editor (with its
// own generate/save/sign UI) was superseded by the discharge summary builder
// at /dashboard/discharge-summaries (list + section editor + sign-off).
// The legacy page was no longer linked from anywhere but stayed URL-reachable
// and could still sign summaries through the deprecated flow (2026-08-09
// hygiene audit, AD-M1). Permanently redirect to the successor.
import { permanentRedirect } from "next/navigation";

export default function LegacyDischargeSummaryRedirect() {
  permanentRedirect("/dashboard/discharge-summaries");
}
