"use client";

import { useEffect, useMemo, useState } from "react";
import { KeyboardIcon, CloseIcon } from "@/components/icons";
import { usePermissions } from "@/hooks/usePermissions";
import {
  GLOBAL_DASHBOARD_SHORTCUTS,
  visibleNavigationShortcuts,
} from "@/lib/dashboardShortcuts";
import { visibleNavSections } from "@/lib/navConfig";

export function KeyboardShortcutsModal() {
  const [open, setOpen] = useState(false);
  const { rawRole, role, isSuperAdmin, hasAllPermissions } = usePermissions();
  const shortcuts = useMemo(() => {
    const visibleSections = visibleNavSections({
      rawRole,
      role,
      isSuperAdmin,
      hasAllPermissions,
    });
    return [
      ...GLOBAL_DASHBOARD_SHORTCUTS,
      ...visibleNavigationShortcuts(visibleSections),
    ];
  }, [rawRole, role, isSuperAdmin, hasAllPermissions]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        // Don't trigger when typing in inputs
        const target = e.target;
        const isTyping =
          target instanceof HTMLElement &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" ||
            target.isContentEditable);
        if (!isTyping) {
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
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        className="relative bg-card border border-border rounded-xl shadow-lg p-6 w-full max-w-md z-50"
      >
        <div className="flex items-center justify-between mb-4">
          <h2
            id="keyboard-shortcuts-title"
            className="text-lg font-semibold flex items-center gap-2"
          >
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
