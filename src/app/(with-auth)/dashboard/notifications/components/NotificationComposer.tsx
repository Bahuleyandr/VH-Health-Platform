// src/app/(with-auth)/dashboard/notifications/components/NotificationComposer.tsx
"use client";

import { useState } from "react";
import { fetchAdminAPI } from "@/lib/api";

type NotificationType = "info" | "warning" | "critical" | "success";
type TargetType = "all" | "department" | "role" | "user";

interface NotificationComposerProps {
  onSuccess?: () => void;
}

const typeStyles: Record<NotificationType, { bg: string; text: string; border: string }> = {
  info: { bg: "bg-blue-50 dark:bg-blue-900/20", text: "text-blue-700 dark:text-blue-300", border: "border-blue-200 dark:border-blue-800" },
  warning: { bg: "bg-amber-50 dark:bg-amber-900/20", text: "text-amber-700 dark:text-amber-300", border: "border-amber-200 dark:border-amber-800" },
  critical: { bg: "bg-red-50 dark:bg-red-900/20", text: "text-red-700 dark:text-red-300", border: "border-red-200 dark:border-red-800" },
  success: { bg: "bg-emerald-50 dark:bg-emerald-900/20", text: "text-emerald-700 dark:text-emerald-300", border: "border-emerald-200 dark:border-emerald-800" },
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
  const [showPreview, setShowPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ msg: string; isError: boolean } | null>(null);

  const canSend = title.trim() && body.trim() && (target === "all" || targetValue.trim());

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setFeedback(null);

    try {
      const payload: Record<string, unknown> = {
        title: title.trim(),
        message: body.trim(),
        type,
        priority: type === "critical" ? "high" : "normal",
      };

      if (target === "all") {
        payload.recipients = ["all"];
      } else {
        payload.target = target;
        payload.targetValue = targetValue.trim();
      }

      if (scheduleMode === "later" && scheduledDate && scheduledTime) {
        payload.scheduledAt = new Date(`${scheduledDate}T${scheduledTime}`).toISOString();
      }

      // Use announcement endpoint for "all", targeted for specific
      if (target === "all") {
        await fetchAdminAPI("/notifications/announce", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      } else {
        await fetchAdminAPI("/notifications/targeted", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }

      setFeedback({ msg: scheduleMode === "later" ? "Notification scheduled!" : "Notification sent!", isError: false });
      setTitle("");
      setBody("");
      setType("info");
      setTarget("all");
      setTargetValue("");
      setScheduleMode("now");
      setScheduledDate("");
      setScheduledTime("");
      setShowPreview(false);
      onSuccess?.();
    } catch (err) {
      setFeedback({ msg: err instanceof Error ? err.message : "Failed to send", isError: true });
    } finally {
      setSending(false);
    }
  }

  const style = typeStyles[type];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Compose Form */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5 space-y-4">
          <h3 className="text-lg font-semibold">Compose Notification</h3>

          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Notification title"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Message */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Notification message body"
              rows={4}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
            />
          </div>

          {/* Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Type</label>
            <div className="flex gap-2">
              {(["info", "warning", "critical", "success"] as NotificationType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    type === t
                      ? `${typeStyles[t].bg} ${typeStyles[t].text} ${typeStyles[t].border}`
                      : "border-gray-200 dark:border-gray-700 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800"
                  }`}
                >
                  {typeIcons[t]} {t}
                </button>
              ))}
            </div>
          </div>

          {/* Target */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Target</label>
            <select
              value={target}
              onChange={(e) => { setTarget(e.target.value as TargetType); setTargetValue(""); }}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
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
                placeholder={target === "department" ? "Department name" : target === "role" ? "Role name" : "User ID or phone"}
                className="mt-2 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
              />
            )}
          </div>

          {/* Schedule */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Schedule</label>
            <div className="flex gap-3">
              <label className="inline-flex items-center gap-1.5 text-sm">
                <input type="radio" name="schedule" checked={scheduleMode === "now"} onChange={() => setScheduleMode("now")} />
                Send now
              </label>
              <label className="inline-flex items-center gap-1.5 text-sm">
                <input type="radio" name="schedule" checked={scheduleMode === "later"} onChange={() => setScheduleMode("later")} />
                Schedule for later
              </label>
            </div>
            {scheduleMode === "later" && (
              <div className="mt-2 flex gap-2">
                <input
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                />
                <input
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                />
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              onClick={() => setShowPreview(true)}
              disabled={!canSend}
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
            >
              👁 Preview
            </button>
            <button
              onClick={handleSend}
              disabled={!canSend || sending}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
            >
              {sending ? "Sending…" : scheduleMode === "later" ? "⏰ Schedule" : "📤 Send Now"}
            </button>
          </div>

          {/* Feedback */}
          {feedback && (
            <div className={`rounded-lg px-3 py-2 text-sm ${feedback.isError ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"}`}>
              {feedback.msg}
            </div>
          )}
        </div>

        {/* Preview Panel */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5">
          <h3 className="text-lg font-semibold mb-4">Preview</h3>
          {title || body ? (
            <div className={`rounded-lg border p-4 ${style.bg} ${style.border}`}>
              <div className="flex items-start gap-2">
                <span className="text-xl">{typeIcons[type]}</span>
                <div>
                  <p className={`font-semibold ${style.text}`}>{title || "Untitled"}</p>
                  <p className={`mt-1 text-sm ${style.text} opacity-80`}>{body || "No message"}</p>
                  <div className="mt-3 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                    <span>Target: {target === "all" ? "All Users" : `${target}: ${targetValue || "—"}`}</span>
                    <span>•</span>
                    <span>{scheduleMode === "now" ? "Immediate" : `Scheduled: ${scheduledDate} ${scheduledTime}`}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-400 dark:text-gray-500">Start typing to see a preview</p>
          )}
        </div>
      </div>
    </div>
  );
}
