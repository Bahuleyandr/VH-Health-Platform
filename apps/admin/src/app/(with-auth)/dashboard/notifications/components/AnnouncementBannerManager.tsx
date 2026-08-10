// src/app/(with-auth)/dashboard/notifications/components/AnnouncementBannerManager.tsx
//
// ADM-2 (review 2026-08-10): the "hospital-wide" banner used to live in
// localStorage, so only the authoring browser ever saw it. It is now
// persisted server-side (tenants.settings.announcementBanner via
// /api/v1/notifications/announcement-banner) so every portal user sees the
// same banner. Only the per-user dismissal state stays in localStorage.
"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";

const DISMISS_KEY = "vhhealth-announcement-banner-dismissed";
const BANNER_QUERY_KEY = ["announcement-banner"];
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

export function AnnouncementBannerManager() {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [type, setType] = useState<BannerData["type"]>("info");
  const [enabled, setEnabled] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const { data } = useQuery({
    queryKey: BANNER_QUERY_KEY,
    queryFn: fetchBanner,
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
    mutationFn: (banner: { text: string; type: BannerData["type"]; enabled: boolean }) =>
      fetchAdminAPI<BannerPayload>(BANNER_ENDPOINT, {
        method: "PUT",
        body: banner,
      }),
    onSuccess: (payload) => {
      queryClient.setQueryData(BANNER_QUERY_KEY, payload);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  function handleSave() {
    saveMutation.mutate({
      text: text.trim(),
      type,
      enabled: enabled && text.trim().length > 0,
    });
  }

  function handleClear() {
    setText("");
    setType("info");
    setEnabled(false);
    saveMutation.mutate({ text: "", type: "info", enabled: false });
  }

  const colors = typeColors[type];

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
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          <span className="text-sm font-medium">Enable banner</span>
        </label>

        {/* Text */}
        <div>
          <label className="block text-sm font-medium text-foreground dark:text-foreground mb-1">
            Banner Text
          </label>
          <input
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
          <label className="block text-sm font-medium text-foreground dark:text-foreground mb-1">
            Style
          </label>
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
  const [dismissed, setDismissed] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: BANNER_QUERY_KEY,
    queryFn: fetchBanner,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    try {
      setDismissedAt(localStorage.getItem(DISMISS_KEY));
    } catch {
      /* ignore */
    }
  }, []);

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
              DISMISS_KEY,
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
