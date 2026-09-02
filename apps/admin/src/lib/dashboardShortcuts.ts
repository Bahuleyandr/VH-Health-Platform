import type { NavSection } from "@/lib/navConfig";

export const GLOBAL_DASHBOARD_SHORTCUTS = [
  { key: "⌘K / Ctrl+K", description: "Open command palette" },
  { key: "?", description: "Show keyboard shortcuts" },
  { key: "Escape", description: "Close modal / sidebar" },
  { key: "⌘/ / Ctrl+/", description: "Focus command search" },
] as const;

export const NAVIGATION_SHORTCUTS = [
  {
    key: "G then D",
    sequenceKey: "d",
    description: "Go to Dashboard",
    href: "/dashboard",
  },
  {
    key: "G then U",
    sequenceKey: "u",
    description: "Go to Users",
    href: "/dashboard/users",
  },
  {
    key: "G then A",
    sequenceKey: "a",
    description: "Go to Appointments",
    href: "/dashboard/appointments",
  },
  {
    key: "G then R",
    sequenceKey: "r",
    description: "Go to Doctors",
    href: "/dashboard/doctors",
  },
] as const;

export type NavigationShortcut = (typeof NAVIGATION_SHORTCUTS)[number];

export function visibleNavigationShortcuts(
  sections: NavSection[],
): NavigationShortcut[] {
  const visibleHrefs = new Set(
    sections.flatMap((section) => section.items.map((item) => item.href)),
  );
  return NAVIGATION_SHORTCUTS.filter((shortcut) =>
    visibleHrefs.has(shortcut.href),
  );
}
