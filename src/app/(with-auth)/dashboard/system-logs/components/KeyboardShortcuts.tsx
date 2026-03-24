// src/app/(with-auth)/dashboard/system-logs/components/KeyboardShortcuts.tsx
"use client";

import { useState } from "react";

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
        className="text-gray-500 hover:text-gray-700 p-2 rounded-md hover:bg-gray-100"
        title="Keyboard shortcuts"
      >
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
          />
        </svg>
      </button>

      {showShortcuts && (
        <div
          role="button"
          tabIndex={0}
          className="fixed inset-0 bg-gray-600 bg-opacity-50 z-50"
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
              <h3 className="text-lg font-bold text-gray-900">
                Keyboard Shortcuts
              </h3>
              <button
                onClick={() => setShowShortcuts(false)}
                className="text-gray-400 hover:text-gray-500"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="space-y-2">
              {shortcuts.map((shortcut) => (
                <div
                  key={shortcut.key}
                  className="flex justify-between items-center"
                >
                  <kbd className="px-2 py-1 text-xs font-semibold text-gray-800 bg-gray-100 border border-gray-200 rounded">
                    {shortcut.key}
                  </kbd>
                  <span className="text-sm text-gray-600">
                    {shortcut.description}
                  </span>
                </div>
              ))}
            </div>

            <p className="mt-4 text-xs text-gray-500 text-center">
              Press any key to close
            </p>
          </div>
        </div>
      )}
    </>
  );
}
