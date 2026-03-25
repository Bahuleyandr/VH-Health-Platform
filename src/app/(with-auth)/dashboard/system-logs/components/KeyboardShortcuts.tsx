// src/app/(with-auth)/dashboard/system-logs/components/KeyboardShortcuts.tsx
"use client";

import { useState } from "react";
import { KeyboardIcon, CloseIcon } from "@/components/icons";

export function KeyboardShortcuts() {
  const [showShortcuts, setShowShortcuts] = useState(false);

  const shortcuts = [
    { key: "R", description: "Refresh logs" },
    { key: "F", description: "Toggle filters" },
    { key: "E", description: "Export logs" },
    { key: "A", description: "Toggle auto-refresh" },
    { key: "/", description: "Focus search" },
    { key: "Tab", description: "Switch log type" },
    { key: "←/→", description: "Navigate pages" },
  ];

  return (
    <>
      <button
        onClick={() => setShowShortcuts(!showShortcuts)}
        className="text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted"
        title="Keyboard shortcuts"
      >
        <KeyboardIcon className="w-5 h-5" />
      </button>

      {showShortcuts && (
        <div
          role="button"
          tabIndex={0}
          className="fixed inset-0 bg-foreground bg-opacity-50 z-50"
          onClick={() => setShowShortcuts(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setShowShortcuts(false); }}
        >
          <div
            role="button"
            tabIndex={0}
            className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl p-6 max-w-sm"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-foreground">
                Keyboard Shortcuts
              </h3>
              <button
                onClick={() => setShowShortcuts(false)}
                className="text-muted-foreground hover:text-muted-foreground"
              >
                <CloseIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2">
              {shortcuts.map((shortcut) => (
                <div
                  key={shortcut.key}
                  className="flex justify-between items-center"
                >
                  <kbd className="px-2 py-1 text-xs font-semibold text-foreground bg-muted border border-border rounded">
                    {shortcut.key}
                  </kbd>
                  <span className="text-sm text-muted-foreground">
                    {shortcut.description}
                  </span>
                </div>
              ))}
            </div>

            <p className="mt-4 text-xs text-muted-foreground text-center">
              Press any key to close
            </p>
          </div>
        </div>
      )}
    </>
  );
}
