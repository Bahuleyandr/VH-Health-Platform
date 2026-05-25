type GenerationModeInput = {
  used_ai?: boolean;
  generation_mode?: string | null;
  provider_status?: string | null;
  fallback_reason?: string | null;
  readiness_reason?: string | null;
};

function normalize(value?: string | null) {
  return (value || "").trim().toLowerCase();
}

function readableStatus(value?: string | null) {
  const normalized = normalize(value);
  if (!normalized) return "Unknown";
  return normalized
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function generationModeFor(generation: GenerationModeInput) {
  const explicitMode = normalize(generation.generation_mode);
  if (explicitMode) return explicitMode;

  const providerStatus = normalize(generation.provider_status);
  if (providerStatus === "used") return "ai";
  if (providerStatus === "blocked") return "blocked";
  if (providerStatus === "schema_unavailable") return "schema_unavailable";
  if (providerStatus === "error" || providerStatus === "template_fallback" || providerStatus === "fallback") {
    return "template_fallback";
  }

  return generation.used_ai ? "ai" : "template_fallback";
}

export function generationModeClass(mode?: string | null) {
  const m = normalize(mode);
  if (m === "ai") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (m === "blocked" || m === "schema_unavailable") return "bg-red-100 text-red-800 border-red-200";
  return "bg-amber-100 text-amber-900 border-amber-200";
}

export function generationModeLabel(mode?: string | null) {
  const m = normalize(mode);
  if (m === "ai") return "AI generated";
  if (m === "blocked") return "Blocked";
  if (m === "schema_unavailable") return "Schema unavailable";
  return "Template fallback";
}

export function providerStatusClass(status?: string | null) {
  const s = normalize(status);
  if (s === "used" || s === "ai") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (s === "blocked" || s === "error" || s === "schema_unavailable") {
    return "bg-red-100 text-red-800 border-red-200";
  }
  return "bg-amber-100 text-amber-900 border-amber-200";
}

export function providerStatusLabel(status?: string | null) {
  const s = normalize(status);
  if (s === "used") return "Provider used";
  if (s === "blocked") return "Provider blocked";
  if (s === "error") return "Provider error";
  if (s === "schema_unavailable") return "Schema unavailable";
  if (s === "template_fallback" || s === "fallback") return "Template fallback";
  return readableStatus(status);
}

export function generationReasonFor(generation: GenerationModeInput) {
  return generation.fallback_reason || generation.readiness_reason || null;
}
