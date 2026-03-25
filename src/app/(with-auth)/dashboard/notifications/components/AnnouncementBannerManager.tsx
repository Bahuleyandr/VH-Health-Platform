// src/app/(with-auth)/dashboard/notifications/components/AnnouncementBannerManager.tsx
"use client";

import { useState, useEffect } from "react";

const STORAGE_KEY = "vhhealth-announcement-banner";

interface BannerData {
  text: string;
  type: "info" | "warning" | "critical" | "success";
  enabled: boolean;
  updatedAt: string;
}

const typeColors = {
  info: { bg: "bg-primary", text: "text-white" },
  warning: { bg: "bg-amber-500", text: "text-white" },
  critical: { bg: "bg-destructive", text: "text-white" },
  success: { bg: "bg-emerald-600", text: "text-white" },
};

export function AnnouncementBannerManager() {
  const [text, setText] = useState("");
  const [type, setType] = useState<BannerData["type"]>("info");
  const [enabled, setEnabled] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data: BannerData = JSON.parse(raw);
        setText(data.text);
        setType(data.type);
        setEnabled(data.enabled);
      }
    } catch { /* ignore */ }
  }, []);

  function handleSave() {
    const data: BannerData = {
      text: text.trim(),
      type,
      enabled: enabled && text.trim().length > 0,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleClear() {
    localStorage.removeItem(STORAGE_KEY);
    setText("");
    setType("info");
    setEnabled(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const colors = typeColors[type];

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border dark:border-border bg-white dark:bg-background p-5 space-y-4">
        <h3 className="text-lg font-semibold">Announcement Banner</h3>
        <p className="text-sm text-muted-foreground dark:text-muted-foreground">
          Set a banner that appears at the top of all dashboard pages. Users can dismiss it.
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
          <label className="block text-sm font-medium text-foreground dark:text-foreground mb-1">Banner Text</label>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. System maintenance scheduled for tonight 10 PM"
            className="w-full rounded-lg border border-input dark:border-input bg-white dark:bg-card px-3 py-2 text-sm"
          />
        </div>

        {/* Type */}
        <div>
          <label className="block text-sm font-medium text-foreground dark:text-foreground mb-1">Style</label>
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
            <p className="text-sm font-medium text-foreground dark:text-foreground mb-1">Preview:</p>
            <div className={`${colors.bg} ${colors.text} px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-between`}>
              <span>📢 {text}</span>
              <span className="opacity-60 text-xs ml-3">✕</span>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90"
          >
            💾 Save Banner
          </button>
          <button
            onClick={handleClear}
            className="px-4 py-2 rounded-lg border border-input dark:border-input text-sm font-medium hover:bg-muted dark:hover:bg-muted"
          >
            Clear
          </button>
          {saved && (
            <span className="inline-flex items-center text-sm text-emerald-600 dark:text-emerald-400">✅ Saved</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * AnnouncementBanner - Display component to be used in layouts
 * Reads from localStorage, shows banner if enabled, dismissible
 */
export function AnnouncementBanner() {
  const [banner, setBanner] = useState<BannerData | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data: BannerData = JSON.parse(raw);
        if (data.enabled && data.text) {
          // Check if user dismissed this version
          const dismissedAt = localStorage.getItem(STORAGE_KEY + "-dismissed");
          if (dismissedAt && dismissedAt >= data.updatedAt) {
            return; // Already dismissed this version
          }
          setBanner(data);
        }
      }
    } catch { /* ignore */ }
  }, []);

  if (!banner || dismissed) return null;

  const colors = typeColors[banner.type];

  return (
    <div className={`${colors.bg} ${colors.text} px-4 py-2.5 text-sm font-medium flex items-center justify-between`}>
      <span>📢 {banner.text}</span>
      <button
        onClick={() => {
          setDismissed(true);
          localStorage.setItem(STORAGE_KEY + "-dismissed", new Date().toISOString());
        }}
        className="ml-3 opacity-70 hover:opacity-100 transition-opacity"
        aria-label="Dismiss announcement"
      >
        ✕
      </button>
    </div>
  );
}
