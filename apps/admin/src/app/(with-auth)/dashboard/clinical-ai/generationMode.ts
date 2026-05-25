type GenerationModeInput = {
  used_ai?: boolean;
  generation_mode?: string | null;
};

export function generationModeFor(generation: GenerationModeInput) {
  return generation.generation_mode || (generation.used_ai ? "ai" : "template_fallback");
}

export function generationModeClass(mode?: string | null) {
  const m = (mode || "").toLowerCase();
  if (m === "ai") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (m === "blocked" || m === "schema_unavailable") return "bg-red-100 text-red-800 border-red-200";
  return "bg-amber-100 text-amber-900 border-amber-200";
}

export function generationModeLabel(mode?: string | null) {
  const m = (mode || "").toLowerCase();
  if (m === "ai") return "AI generated";
  if (m === "blocked") return "Blocked";
  if (m === "schema_unavailable") return "Schema unavailable";
  return "Template fallback";
}
