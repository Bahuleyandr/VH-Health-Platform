import { NAVIGATION_SHORTCUTS } from "@/lib/dashboardShortcuts";
import { NAV_ITEMS } from "@/lib/navConfig";

describe("dashboard shortcut contract", () => {
  test("every navigation shortcut targets a unique registered nav route", () => {
    const navHrefs = new Set(NAV_ITEMS.map((item) => item.href));
    const sequenceKeys = NAVIGATION_SHORTCUTS.map(
      (shortcut) => shortcut.sequenceKey,
    );
    const shortcutHrefs = NAVIGATION_SHORTCUTS.map((shortcut) => shortcut.href);

    expect(new Set(sequenceKeys).size).toBe(sequenceKeys.length);
    expect(new Set(shortcutHrefs).size).toBe(shortcutHrefs.length);
    for (const href of shortcutHrefs) expect(navHrefs.has(href)).toBe(true);
  });

  test("displayed sequences match their registered follow-up keys", () => {
    for (const shortcut of NAVIGATION_SHORTCUTS) {
      expect(shortcut.key).toBe(`G then ${shortcut.sequenceKey.toUpperCase()}`);
    }
  });
});
