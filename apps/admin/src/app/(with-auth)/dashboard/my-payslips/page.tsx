"use client";

import { fetchAdminAPI } from "@/lib/api";
import { API_ENDPOINTS } from "@/lib/api-config";
import { apiFetch } from "@/lib/api-fetch";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

interface Payslip {
  id: string;
  month: number;
  year: number;
  netSalary: number;
  grossSalary: number;
  totalDeductions: number;
  status: string;
}

interface RevealedCredential {
  payslipId: string;
  password: string;
}

class PasswordRequestError extends Error {
  constructor(readonly status: number) {
    super("Payslip password request failed");
  }
}

const STATUS_STYLE: Record<string, string> = {
  issued: "bg-blue-500/20 text-blue-400",
  viewed: "bg-yellow-500/20 text-yellow-400",
  downloaded: "bg-green-500/20 text-green-400",
};
const CLIENT_API_BASE_URL = "/api/proxy";
const JSON_HEADERS: HeadersInit = { "Content-Type": "application/json" };

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
  }).format(amount);
}

function formatMonth(month: number, year: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePayslip(value: unknown): Payslip | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const month = finiteNumber(item.month);
  const year = finiteNumber(item.year);
  const grossSalary = finiteNumber(item.gross_salary);
  const netSalary = finiteNumber(item.net_salary);
  const totalDeductions = finiteNumber(item.total_deductions);
  if (
    item.id == null ||
    month == null ||
    year == null ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(year) ||
    grossSalary == null ||
    netSalary == null ||
    totalDeductions == null
  ) {
    return null;
  }
  return {
    id: String(item.id),
    month,
    year,
    grossSalary,
    netSalary,
    totalDeductions,
    status: String(item.status ?? "unknown").toLowerCase(),
  };
}

function normalizePayslipList(payload: unknown): Payslip[] {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as { data?: unknown; payslips?: unknown }).data ??
        (payload as { payslips?: unknown }).payslips)
      : [];
  if (!Array.isArray(records)) return [];
  return records.flatMap((record) => {
    const normalized = normalizePayslip(record);
    return normalized ? [normalized] : [];
  });
}

function safePasswordError(status: number): string {
  if (status === 400) return "This payslip request is invalid.";
  if (status === 401) return "Your session has expired. Sign in again.";
  if (status === 403) {
    return "You do not have permission to view this payslip password.";
  }
  if (status === 404) return "A password is not available for this payslip.";
  return "Unable to retrieve the payslip password. Try again.";
}

export default function MyPayslipsPage() {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [credential, setCredential] = useState<RevealedCredential | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
  );
  const passwordRequest = useRef<AbortController | null>(null);
  const credentialRef = useRef<RevealedCredential | null>(null);
  const mounted = useRef(true);

  const {
    data: payslips = [],
    isLoading: loading,
    isError: payslipLoadFailed,
  } = useQuery({
    queryKey: ["my-payslips"],
    queryFn: async () =>
      normalizePayslipList(
        await fetchAdminAPI<unknown>(API_ENDPOINTS.myWork.payslips.list),
      ),
  });

  useEffect(() => {
    mounted.current = true;
    const clearSensitiveState = () => {
      credentialRef.current = null;
      setCredential(null);
      setPasswordVisible(false);
      setCopyStatus(null);
    };
    window.addEventListener("pagehide", clearSensitiveState);
    return () => {
      mounted.current = false;
      passwordRequest.current?.abort();
      passwordRequest.current = null;
      credentialRef.current = null;
      window.removeEventListener("pagehide", clearSensitiveState);
    };
  }, []);

  const clearCredential = () => {
    credentialRef.current = null;
    setCredential(null);
    setPasswordVisible(false);
    setCopyStatus(null);
  };

  const revealPassword = async (payslipId: string) => {
    if (revealing !== null) return;
    const controller = new AbortController();
    passwordRequest.current = controller;
    setRevealing(payslipId);
    setPasswordError(null);
    clearCredential();
    try {
      const response = await apiFetch(
        API_ENDPOINTS.myWork.payslips.password(payslipId),
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: "{}",
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new PasswordRequestError(response.status);
      const payload = (await response.json()) as {
        data?: { password?: unknown };
      };
      const password = payload.data?.password;
      if (typeof password !== "string" || password.length === 0) {
        throw new PasswordRequestError(500);
      }
      if (!mounted.current) return;
      const nextCredential = { payslipId, password };
      credentialRef.current = nextCredential;
      setCredential(nextCredential);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!mounted.current) return;
      const status = error instanceof PasswordRequestError ? error.status : 500;
      setPasswordError(safePasswordError(status));
    } finally {
      if (passwordRequest.current === controller)
        passwordRequest.current = null;
      if (mounted.current) setRevealing(null);
    }
  };

  const copyPassword = async () => {
    const password = credentialRef.current?.password;
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  const downloadPayslip = async (id: string) => {
    setDownloading(id);
    try {
      const res = await apiFetch(API_ENDPOINTS.myWork.payslips.download(id), {
        headers: JSON_HEADERS,
      });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `payslip-${id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Download failed. Please try again.");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">My Payslips</h1>
        <a
          href={`${CLIENT_API_BASE_URL}${API_ENDPOINTS.myWork.payslips.taxSummary}`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded bg-muted px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Annual Tax Summary ↗
        </a>
      </div>

      {loading && (
        <p className="text-muted-foreground text-sm">Loading payslips…</p>
      )}
      {payslipLoadFailed && (
        <div className="rounded bg-red-500/10 border border-red-500/30 px-4 py-2 text-sm text-red-400">
          Unable to load payslips.
        </div>
      )}
      {passwordError && (
        <div
          role="alert"
          className="rounded bg-red-500/10 border border-red-500/30 px-4 py-2 text-sm text-red-400"
        >
          {passwordError}
        </div>
      )}

      {!loading && !payslipLoadFailed && payslips.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No payslips found.
        </div>
      )}

      <div className="space-y-3">
        {payslips.map((p) => (
          <div
            key={p.id}
            className="rounded-lg border border-border bg-card p-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-white">
                  {formatMonth(p.month, p.year)}
                </p>
                <p className="text-sm text-muted-foreground">
                  Gross: {formatCurrency(p.grossSalary)} · Deductions:{" "}
                  {formatCurrency(p.totalDeductions)}
                </p>
                <p className="text-base font-bold text-green-400 mt-1">
                  Net: {formatCurrency(p.netSalary)}
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[p.status] ?? "bg-gray-500/20 text-gray-400"}`}
                >
                  {p.status}
                </span>
                <button
                  disabled={revealing !== null}
                  onClick={() => void revealPassword(p.id)}
                  className="rounded border border-indigo-400/50 px-3 py-1 text-xs font-medium text-indigo-300 hover:bg-indigo-500/10 disabled:opacity-50"
                >
                  {revealing === p.id ? "Retrieving…" : "View PDF password"}
                </button>
                <button
                  disabled={downloading === p.id}
                  onClick={() => void downloadPayslip(p.id)}
                  className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {downloading === p.id ? "Downloading…" : "↓ PDF"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {credential && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="payslip-password-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
            <h2
              id="payslip-password-title"
              className="text-lg font-semibold text-white"
            >
              Payslip PDF password
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This password is kept only while this dialog is open.
            </p>
            <input
              aria-label="Masked payslip PDF password"
              type={passwordVisible ? "text" : "password"}
              value={credential.password}
              readOnly
              autoComplete="off"
              spellCheck={false}
              className="mt-4 w-full rounded border border-border bg-background px-3 py-2 font-mono text-foreground"
            />
            {copyStatus && (
              <p className="mt-2 text-xs text-muted-foreground" role="status">
                {copyStatus === "copied" ? "Copied." : "Unable to copy."}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPasswordVisible((visible) => !visible)}
                className="rounded border border-border px-3 py-1.5 text-sm text-foreground"
              >
                {passwordVisible ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                onClick={() => void copyPassword()}
                className="rounded border border-border px-3 py-1.5 text-sm text-foreground"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={clearCredential}
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
