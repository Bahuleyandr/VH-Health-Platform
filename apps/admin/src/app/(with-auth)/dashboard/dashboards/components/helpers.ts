// Shared formatters + error mapping for the BI Dashboards page.

import { APIError } from "@/lib/api";

export function label(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function compactRoles(roles: string[]) {
  if (roles.length <= 3) return roles.join(", ");
  return `${roles.slice(0, 3).join(", ")} +${roles.length - 3}`;
}

export function statusClass(status: string) {
  if (status === "active")
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "held") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export function governanceClass(phiClass: string) {
  if (phiClass.includes("phi"))
    return "border-rose-200 bg-rose-50 text-rose-800";
  if (phiClass === "financial")
    return "border-blue-200 bg-blue-50 text-blue-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

/** Map an embed failure onto its backend error code (fail-closed states). */
export function embedErrorInfo(err: unknown): {
  code: string | null;
  message: string;
} {
  if (err instanceof APIError) {
    const payload = err.data as { code?: string; message?: string } | undefined;
    return {
      code: typeof payload?.code === "string" ? payload.code : null,
      message: payload?.message || err.message,
    };
  }
  return {
    code: null,
    message: err instanceof Error ? err.message : "Failed to load embed",
  };
}
