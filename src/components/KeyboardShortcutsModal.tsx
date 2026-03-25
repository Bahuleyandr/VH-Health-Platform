"use client";

import { useEffect, useState } from "react";
import { KeyboardIcon, CloseIcon } from "@/components/icons";

const shortcuts = [
  { key: "⌘K / Ctrl+K", description: "Open command palette" },
  { key: "?", description: "Show keyboard shortcuts" },
  { key: "Escape", description: "Close modal / sidebar" },
  { key: "⌘/ / Ctrl+/", description: "Focus search" },
  { key: "G then D", description: "Go to Dashboard" },
  { key: "G then U", description: "Go to Users" },
  { key: "G then A", description: "Go to Appointments" },
  { key: "G then Dr", description: "Go to Doctors" },
];

export function KeyboardShortcutsModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        // Don't trigger when typing in inputs
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          setOpen((prev) => !prev);
        }
      }
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-background/80 backdrop-blur-sm"
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />
      <div className="relative bg-card border border-border rounded-xl shadow-lg p-6 w-full max-w-md z-50">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <KeyboardIcon className="w-5 h-5" />
            Keyboard Shortcuts
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close keyboard shortcuts"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="space-y-2">
          {shortcuts.map((s) => (
            <div
              key={s.key}
              className="flex justify-between items-center py-1.5 border-b border-border last:border-0"
            >
              <span className="text-muted-foreground text-sm">{s.description}</span>
              <kbd className="px-2 py-0.5 text-xs bg-muted text-muted-foreground rounded border border-border font-mono">
                {s.key}
              </kbd>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-4">
          Press{" "}
          <kbd className="px-1 bg-muted rounded border border-border font-mono">
            ?
          </kbd>{" "}
          to toggle this panel
        </p>
      </div>
    </div>
  );
}
