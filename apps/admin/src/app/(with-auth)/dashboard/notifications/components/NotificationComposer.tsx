// src/app/(with-auth)/dashboard/notifications/components/NotificationComposer.tsx
"use client";

import { useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import {
  buildNotificationComposerRequest,
  type ComposerNotificationType as NotificationType,
  type ComposerTargetType as TargetType,
} from "./notificationComposerContract";

interface NotificationComposerProps {
  onSuccess?: () => void;
}

const typeStyles: Record<
  NotificationType,
  { bg: string; text: string; border: string }
> = {
  info: {
    bg: "bg-primary/10 dark:bg-primary/20",
    text: "text-primary dark:text-primary/70",
    border: "border-primary/20 dark:border-primary/30",
  },
  warning: {
    bg: "bg-amber-50 dark:bg-amber-900/20",
    text: "text-amber-700 dark:text-amber-300",
    border: "border-amber-200 dark:border-amber-800",
  },
  critical: {
    bg: "bg-destructive/10 dark:bg-destructive/20",
    text: "text-destructive dark:text-destructive/70",
    border: "border-destructive/30 dark:border-destructive/30",
  },
  success: {
    bg: "bg-emerald-50 dark:bg-emerald-900/20",
    text: "text-emerald-700 dark:text-emerald-300",
    border: "border-emerald-200 dark:border-emerald-800",
  },
};

const typeIcons: Record<NotificationType, string> = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🚨",
  success: "✅",
};

export function NotificationComposer({ onSuccess }: NotificationComposerProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [type, setType] = useState<NotificationType>("info");
  const [target, setTarget] = useState<TargetType>("all");
  const [targetValue, setTargetValue] = useState("");
  const [scheduleMode, setScheduleMode] = useState<"now" | "later">("now");
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");

  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{
    msg: string;
    isError: boolean;
  } | null>(null);

  const canSend = Boolean(
    title.trim() &&
    body.trim() &&
    (target === "all" || targetValue.trim()) &&
    (scheduleMode === "now" || (scheduledDate && scheduledTime)),
  );

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setFeedback(null);

    try {
      const request = buildNotificationComposerRequest({
        title,
        message: body,
        type,
        target,
        targetValue,
        scheduledDate: scheduleMode === "later" ? scheduledDate : undefined,
        scheduledTime: scheduleMode === "later" ? scheduledTime : undefined,
      });

      await fetchAdminAPI(request.endpoint, {
        method: "POST",
        body: request.payload,
      });

      setFeedback({
        msg:
          scheduleMode === "later"
            ? "Notification scheduled!"
            : "Notification sent!",
        isError: false,
      });
      setTitle("");
      setBody("");
      setType("info");
      setTarget("all");
      setTargetValue("");
      setScheduleMode("now");
      setScheduledDate("");
      setScheduledTime("");
      onSuccess?.();
    } catch (err) {
      setFeedback({
        msg: err instanceof Error ? err.message : "Failed to send",
        isError: true,
      });
    } finally {
      setSending(false);
    }
  }

  const style = typeStyles[type];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Compose Form */}
        <div className="rounded-xl border border-border dark:border-border bg-card dark:bg-background p-5 space-y-4">
          <h3 className="text-lg font-semibold">Compose Notification</h3>

          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-foreground dark:text-foreground mb-1">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Notification title"
              className="w-full rounded-lg border border-input dark:border-input bg-card dark:bg-card px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:border-transparent"
            />
          </div>

          {/* Message */}
          <div>
            <label className="block text-sm font-medium text-foreground dark:text-foreground mb-1">
              Message
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Notification message body"
              rows={4}
              className="w-full rounded-lg border border-input dark:border-input bg-card dark:bg-card px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:border-transparent resize-y"
            />
          </div>

          {/* Type */}
          <div>
            <label className="block text-sm font-medium text-foreground dark:text-foreground mb-1">
              Type
            </label>
            <div className="flex gap-2">
              {(
                ["info", "warning", "critical", "success"] as NotificationType[]
              ).map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    type === t
                      ? `${typeStyles[t].bg} ${typeStyles[t].text} ${typeStyles[t].border}`
                      : "border-border dark:border-border text-muted-foreground hover:bg-muted dark:hover:bg-muted"
                  }`}
                >
                  {typeIcons[t]} {t}
                </button>
              ))}
            </div>
          </div>

          {/* Target */}
          <div>
            <label className="block text-sm font-medium text-foreground dark:text-foreground mb-1">
              Target
            </label>
            <select
              value={target}
              onChange={(e) => {
                setTarget(e.target.value as TargetType);
                setTargetValue("");
              }}
              className="w-full rounded-lg border border-input dark:border-input bg-card dark:bg-card px-3 py-2 text-sm"
            >
              <option value="all">All Users</option>
              <option value="department">Specific Department</option>
              <option value="role">Specific Role</option>
              <option value="user">Specific User</option>
            </select>
            {target !== "all" && (
              <input
                type="text"
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                placeholder={
                  target === "department"
                    ? "Department name"
                    : target === "role"
                      ? "Role name"
                      : "Numeric user IDs, separated by commas"
                }
                className="mt-2 w-full rounded-lg border border-input dark:border-input bg-card dark:bg-card px-3 py-2 text-sm"
              />
            )}
          </div>

          {/* Schedule */}
          <div>
            <label className="block text-sm font-medium text-foreground dark:text-foreground mb-1">
              Schedule
            </label>
            <div className="flex gap-3">
              <label className="inline-flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="schedule"
                  checked={scheduleMode === "now"}
                  onChange={() => setScheduleMode("now")}
                />
                Send now
              </label>
              <label className="inline-flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="schedule"
                  checked={scheduleMode === "later"}
                  onChange={() => setScheduleMode("later")}
                />
                Schedule for later
              </label>
            </div>
            {scheduleMode === "later" && (
              <div className="mt-2 flex gap-2">
                <input
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  className="rounded-lg border border-input dark:border-input bg-card dark:bg-card px-3 py-2 text-sm"
                />
                <input
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="rounded-lg border border-input dark:border-input bg-card dark:bg-card px-3 py-2 text-sm"
                />
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              onClick={handleSend}
              disabled={!canSend || sending}
              className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-40"
            >
              {sending
                ? "Sending…"
                : scheduleMode === "later"
                  ? "⏰ Schedule"
                  : "📤 Send Now"}
            </button>
          </div>

          {/* Feedback */}
          {feedback && (
            <div
              className={`rounded-lg px-3 py-2 text-sm ${feedback.isError ? "bg-destructive/10 text-destructive dark:bg-destructive/30 dark:text-destructive/70" : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"}`}
            >
              {feedback.msg}
            </div>
          )}
        </div>

        {/* Preview Panel */}
        <div className="rounded-xl border border-border dark:border-border bg-card dark:bg-background p-5">
          <h3 className="text-lg font-semibold mb-4">Preview</h3>
          {title || body ? (
            <div
              className={`rounded-lg border p-4 ${style.bg} ${style.border}`}
            >
              <div className="flex items-start gap-2">
                <span className="text-xl">{typeIcons[type]}</span>
                <div>
                  <p className={`font-semibold ${style.text}`}>
                    {title || "Untitled"}
                  </p>
                  <p className={`mt-1 text-sm ${style.text} opacity-80`}>
                    {body || "No message"}
                  </p>
                  <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground dark:text-muted-foreground">
                    <span>
                      Target:{" "}
                      {target === "all"
                        ? "All Users"
                        : `${target}: ${targetValue || "—"}`}
                    </span>
                    <span>•</span>
                    <span>
                      {scheduleMode === "now"
                        ? "Immediate"
                        : `Scheduled: ${scheduledDate} ${scheduledTime}`}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground dark:text-muted-foreground">
              Start typing to see a preview
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
