// src/app/(with-auth)/dashboard/notifications/components/AnnouncementBannerManager.tsx
//
// ADM-2 (review 2026-08-10): the "hospital-wide" banner used to live in
// localStorage, so only the authoring browser ever saw it. It is now
// persisted server-side (tenants.settings.announcementBanner via
// /api/v1/notifications/announcement-banner) so every portal user sees the
// same banner. Only the per-user dismissal state stays in localStorage.
"use client";

import {
  ActingTenantReadinessNotice,
  useActiveTenantScope,
} from "@/components/ActingTenantBanner";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useActingTenant } from "@/contexts/ActingTenantContext";
import { useAuth } from "@/contexts/AuthContext";
import { useTenant } from "@/contexts/TenantContext";
import { fetchAdminAPI } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";

const DISMISS_KEY = "vhhealth-announcement-banner-dismissed";
const BANNER_ENDPOINT = "/notifications/announcement-banner";

interface BannerData {
  text: string;
  type: "info" | "warning" | "critical" | "success";
  enabled: boolean;
  updated_at: string | null;
}

interface BannerPayload {
  banner: BannerData | null;
}

const typeColors = {
  info: { bg: "bg-primary", text: "text-white" },
  warning: { bg: "bg-amber-500", text: "text-white" },
  critical: { bg: "bg-destructive", text: "text-white" },
  success: { bg: "bg-emerald-600", text: "text-white" },
};

function fetchBanner() {
  return fetchAdminAPI<BannerPayload>(BANNER_ENDPOINT);
}

function bannerQueryKey(scopeKey: string) {
  return ["announcement-banner", scopeKey] as const;
}

export function AnnouncementBannerManager() {
  const { isReady, scopeKey, error, retry } = useActingTenant();
  if (!isReady || !scopeKey)
    return <ActingTenantReadinessNotice error={error} retry={retry} />;
  return <ScopedAnnouncementBannerManager key={scopeKey} scopeKey={scopeKey} />;
}

function ScopedAnnouncementBannerManager({ scopeKey }: { scopeKey: string }) {
  const activeScope = useActiveTenantScope(scopeKey);
  const queryClient = useQueryClient();
  const queryKey = bannerQueryKey(scopeKey);
  const [text, setText] = useState("");
  const [type, setType] = useState<BannerData["type"]>("info");
  const [enabled, setEnabled] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const { data, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      activeScope.assertCurrent();
      const data = await fetchBanner();
      activeScope.assertCurrent();
      return data;
    },
  });

  // Hydrate the form once from the server copy.
  useEffect(() => {
    if (hydrated || !data) return;
    const banner = data.banner;
    if (banner) {
      setText(banner.text);
      setType(banner.type);
      setEnabled(banner.enabled);
    }
    setHydrated(true);
  }, [data, hydrated]);

  const saveMutation = useMutation({
    mutationFn: (banner: {
      text: string;
      type: BannerData["type"];
      enabled: boolean;
    }) => {
      activeScope.assertCurrent();
      return fetchAdminAPI<BannerPayload>(BANNER_ENDPOINT, {
        method: "PUT",
        body: banner,
      });
    },
    onSuccess: (payload) => {
      if (!activeScope.current) return;
      queryClient.setQueryData(queryKey, payload);
      setSaved(true);
      setTimeout(() => {
        if (activeScope.current) setSaved(false);
      }, 2000);
    },
  });

  function handleSave() {
    if (!activeScope.current || !hydrated || saveMutation.isPending) return;
    saveMutation.mutate({
      text: text.trim(),
      type,
      enabled: enabled && text.trim().length > 0,
    });
  }

  function handleClear() {
    if (!activeScope.current || !hydrated || saveMutation.isPending) return;
    setText("");
    setType("info");
    setEnabled(false);
    saveMutation.mutate({ text: "", type: "info", enabled: false });
  }

  const colors = typeColors[type];

  if (isError)
    return (
      <div role="alert">
        Could not load the announcement banner.
        <button type="button" onClick={() => void refetch()}>
          Retry banner
        </button>
      </div>
    );
  if (!hydrated) return <LoadingSpinner />;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border dark:border-border bg-card dark:bg-background p-5 space-y-4">
        <h3 className="text-lg font-semibold">Announcement Banner</h3>
        <p className="text-sm text-muted-foreground dark:text-muted-foreground">
          Set a banner that appears at the top of all dashboard pages for every
          portal user. Users can dismiss it.
        </p>

        {/* Enable toggle */}
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            aria-label="Enable banner"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          <span className="text-sm font-medium">Enable banner</span>
        </label>

        {/* Text */}
        <div>
          <label
            htmlFor="announcement-banner-text"
            className="block text-sm font-medium text-foreground dark:text-foreground mb-1"
          >
            Banner Text
          </label>
          <input
            id="announcement-banner-text"
            aria-label="Banner Text"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={300}
            placeholder="e.g. System maintenance scheduled for tonight 10 PM"
            className="w-full rounded-lg border border-input dark:border-input bg-card dark:bg-card px-3 py-2 text-sm"
          />
        </div>

        {/* Type */}
        <div>
          <p className="block text-sm font-medium text-foreground dark:text-foreground mb-1">
            Style
          </p>
          <div className="flex gap-2">
            {(["info", "warning", "critical", "success"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  type === t
                    ? `${typeColors[t].bg} ${typeColors[t].text} border-transparent`
                    : "border-border dark:border-border text-muted-foreground hover:bg-muted dark:hover:bg-muted"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Preview */}
        {text.trim() && enabled && (
          <div>
            <p className="text-sm font-medium text-foreground dark:text-foreground mb-1">
              Preview:
            </p>
            <div
              className={`${colors.bg} ${colors.text} px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-between`}
            >
              <span>📢 {text}</span>
              <span className="opacity-60 text-xs ml-3">✕</span>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            💾 Save Banner
          </button>
          <button
            onClick={handleClear}
            disabled={saveMutation.isPending}
            className="px-4 py-2 rounded-lg border border-input dark:border-input text-sm font-medium hover:bg-muted dark:hover:bg-muted disabled:opacity-50"
          >
            Clear
          </button>
          {saved && (
            <span
              className="inline-flex items-center text-sm text-emerald-600 dark:text-emerald-400"
              role="status"
              aria-live="polite"
            >
              ✅ Saved
            </span>
          )}
          {saveMutation.isError && (
            <span
              className="inline-flex items-center text-sm text-destructive"
              role="status"
              aria-live="polite"
            >
              Failed to save banner
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * AnnouncementBanner - Display component used in the dashboard layout.
 * Reads the tenant-wide banner from the backend; dismissal is per-user
 * (localStorage, keyed by the banner's updated_at).
 */
export function AnnouncementBanner() {
  const { user } = useAuth();
  const { actingTenant, isReady, scopeKey } = useActingTenant();
  const { tenant } = useTenant();
  const tenantScope = actingTenant?.id ?? tenant?.id ?? `own:${scopeKey}`;
  if (!isReady || !scopeKey || !user?.uid) return null;
  const dismissalKey = `${DISMISS_KEY}:${tenantScope}:${user.uid}`;
  return (
    <ScopedAnnouncementBanner
      key={`${scopeKey}:${dismissalKey}`}
      scopeKey={scopeKey}
      dismissalKey={dismissalKey}
    />
  );
}

function ScopedAnnouncementBanner({
  scopeKey,
  dismissalKey,
}: {
  scopeKey: string;
  dismissalKey: string;
}) {
  const activeScope = useActiveTenantScope(scopeKey);
  const [dismissed, setDismissed] = useState(false);
  const [dismissedAt] = useState<string | null>(() => {
    try {
      return localStorage.getItem(dismissalKey);
    } catch {
      return null;
    }
  });
  const queryKey = bannerQueryKey(scopeKey);

  const { data } = useQuery({
    queryKey,
    queryFn: async () => {
      activeScope.assertCurrent();
      const data = await fetchBanner();
      activeScope.assertCurrent();
      return data;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const banner = data?.banner ?? null;
  if (!banner || !banner.enabled || !banner.text || dismissed) return null;
  if (dismissedAt && banner.updated_at && dismissedAt >= banner.updated_at) {
    return null; // already dismissed this version
  }

  const colors = typeColors[banner.type] ?? typeColors.info;
  const liveRole = banner.type === "critical" ? "alert" : "status";
  const ariaLive = banner.type === "critical" ? "assertive" : "polite";

  return (
    <div
      className={`${colors.bg} ${colors.text} px-4 py-2.5 text-sm font-medium flex items-center justify-between`}
      role={liveRole}
      aria-live={ariaLive}
      aria-label={`${banner.type} announcement`}
    >
      <span>📢 {banner.text}</span>
      <button
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(
              dismissalKey,
              banner.updated_at ?? new Date().toISOString(),
            );
          } catch {
            /* ignore */
          }
        }}
        className="ml-3 opacity-70 hover:opacity-100 transition-opacity"
        aria-label="Dismiss announcement"
      >
        ✕
      </button>
    </div>
  );
}
