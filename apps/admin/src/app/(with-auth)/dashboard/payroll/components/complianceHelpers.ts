// src/app/(with-auth)/dashboard/payroll/components/complianceHelpers.ts
// Helpers shared by the compliance sub-sections (calendar, F&F, gratuity,
// declarations, queries, bulk revisions, leave encashment).

import { buildProxyUrl } from "@/lib/api-config";
import type { InvestmentDeclaration } from "@/lib/api/payroll";

export function unwrap<T>(x: unknown): T {
  if (x && typeof x === "object" && "data" in x) return (x as { data: T }).data;
  return x as T;
}

export function fmtCurrency(v: string | number | null | undefined): string {
  const n = parseFloat(String(v || 0));
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function sum80C(d: InvestmentDeclaration): number {
  return [d.ppf, d.epf_voluntary, d.elss, d.lic_premium, d.nsc, d.home_loan_principal, d.tuition_fees, d.other_80c]
    .reduce((a, v) => a + parseFloat(String(v || 0)), 0);
}

export function sum80D(d: InvestmentDeclaration): number {
  return parseFloat(String(d.health_insurance_self || 0)) + parseFloat(String(d.health_insurance_parents || 0));
}

export const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function proxyDownloadHref(path: string): string {
  return buildProxyUrl(path);
}
