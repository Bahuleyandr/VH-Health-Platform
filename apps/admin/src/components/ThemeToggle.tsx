"use client";

import { useTheme } from "@/hooks/useTheme";
import { MoonIcon, SunIcon } from "@/components/icons";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className="p-2 rounded-lg hover:bg-muted dark:hover:bg-muted transition-colors"
      aria-label="Toggle theme"
    >
      {theme === "light" ? (
        <MoonIcon className="w-5 h-5 text-muted-foreground dark:text-muted-foreground" />
      ) : (
        <SunIcon className="w-5 h-5 text-muted-foreground dark:text-muted-foreground" />
      )}
    </button>
  );
}
