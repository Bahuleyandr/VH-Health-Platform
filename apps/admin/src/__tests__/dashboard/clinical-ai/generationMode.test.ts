import {
  generationReasonFor,
  generationModeClass,
  generationModeFor,
  generationModeLabel,
  providerStatusClass,
  providerStatusLabel,
} from "@/app/(with-auth)/dashboard/clinical-ai/generationMode";
import { approvalDetailLines } from "@/app/(with-auth)/dashboard/clinical-ai/approvalDetails";

describe("Clinical AI generation mode helpers", () => {
  it("falls back from used_ai when explicit mode is absent", () => {
    expect(generationModeFor({ used_ai: true })).toBe("ai");
    expect(generationModeFor({ used_ai: false })).toBe("template_fallback");
  });

  it("uses provider status when legacy rows lack an explicit generation mode", () => {
    expect(generationModeFor({ provider_status: "used" })).toBe("ai");
    expect(generationModeFor({ provider_status: "blocked" })).toBe("blocked");
    expect(generationModeFor({ provider_status: "schema_unavailable" })).toBe("schema_unavailable");
    expect(generationModeFor({ provider_status: "error" })).toBe("template_fallback");
  });

  it("keeps blocked and schema-unavailable states visually urgent", () => {
    expect(generationModeLabel("blocked")).toBe("Blocked");
    expect(generationModeLabel("schema_unavailable")).toBe("Schema unavailable");
    expect(generationModeClass("blocked")).toContain("bg-red");
    expect(generationModeClass("schema_unavailable")).toContain("bg-red");
  });

  it("labels template fallback distinctly from AI output", () => {
    expect(generationModeLabel("template_fallback")).toBe("Template fallback");
    expect(generationModeClass("template_fallback")).toContain("bg-amber");
    expect(generationModeLabel("ai")).toBe("AI generated");
    expect(generationModeClass("ai")).toContain("bg-emerald");
  });

  it("surfaces provider status and fallback reasons for admin review", () => {
    expect(providerStatusLabel("used")).toBe("Provider used");
    expect(providerStatusLabel("blocked")).toBe("Provider blocked");
    expect(providerStatusClass("blocked")).toContain("bg-red");
    expect(generationReasonFor({
      fallback_reason: "tenant_region_not_allowed_for_stt",
      readiness_reason: "provider_not_ready",
    })).toBe("tenant_region_not_allowed_for_stt");
  });

  it("summarizes risky module approval payloads for approvers", () => {
    expect(approvalDetailLines({
      approval_type: "module_governance_change",
      payload: {
        scope: "tenant",
        changed_fields: ["enabled", "external_allowed"],
        next: { enabled: true, external_allowed: true },
        reasons: ["two_person_enablement", "risky_runtime_change:external_allowed"],
        eval_gate: { provider: "openai", model: "gpt-4.1", eval_run_id: 17 },
        requested_change_hash: "abcdef1234567890",
      },
    })).toEqual([
      "Scope: tenant",
      "Changes: enabled, external_allowed",
      "Requested: enabled=true, external_allowed=true",
      "Gate: two_person_enablement, risky_runtime_change:external_allowed",
      "Eval: openai/gpt-4.1 run #17",
      "Hash: abcdef123456",
    ]);
  });
});
