// src/components/CommandPalette.tsx
"use client";

import {
  FileTextIcon,
  MoonIcon,
  RefreshIcon,
  SearchIcon,
} from "@/components/icons";
import { usePermissions } from "@/hooks/usePermissions";
import {
  visibleNavigationShortcuts,
  type NavigationShortcut,
} from "@/lib/dashboardShortcuts";
import { visibleNavSections } from "@/lib/navConfig";
import { Dialog, Transition } from "@headlessui/react";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";

interface Command {
  id: string;
  name: string;
  description?: string;
  icon?: React.ReactNode;
  action: () => void;
  keywords?: string[];
}

export function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const router = useRouter();
  const { rawRole, role, isSuperAdmin, hasAllPermissions } = usePermissions();

  const visibleSections = useMemo(
    () =>
      visibleNavSections({
        rawRole,
        role,
        isSuperAdmin,
        hasAllPermissions,
      }),
    [rawRole, role, isSuperAdmin, hasAllPermissions],
  );

  const commands = useMemo<Command[]>(() => {
    const navigation = visibleSections.flatMap((section) =>
      section.items.map((item) => ({
        id: `go-${item.href}`,
        name: item.name,
        description: section.title,
        icon: <FileTextIcon className="w-5 h-5" />,
        action: () => {
          router.push(item.href);
          setIsOpen(false);
        },
        keywords: [section.title, item.href.replaceAll("/", " ")],
      })),
    );

    return [
      ...navigation,
      {
        id: "toggle-theme",
        name: "Toggle Dark Mode",
        description: "Switch between light and dark theme",
        icon: <MoonIcon className="w-5 h-5" />,
        action: () => {
          document.documentElement.classList.toggle("dark");
          const isDark = document.documentElement.classList.contains("dark");
          localStorage.setItem("theme", isDark ? "dark" : "light");
          toast.success(`Switched to ${isDark ? "dark" : "light"} mode`);
          setIsOpen(false);
        },
        keywords: ["dark", "light", "theme", "mode"],
      },
      {
        id: "refresh-data",
        name: "Refresh Current Page",
        description: "Reload data on current page",
        icon: <RefreshIcon className="w-5 h-5" />,
        action: () => {
          window.location.reload();
          setIsOpen(false);
        },
        keywords: ["reload", "update", "sync"],
      },
    ];
  }, [visibleSections, router]);

  const navigationShortcuts = useMemo(
    () => visibleNavigationShortcuts(visibleSections),
    [visibleSections],
  );
  const navigationShortcutByKey = useMemo(
    () =>
      new Map<string, NavigationShortcut>(
        navigationShortcuts.map((shortcut) => [
          shortcut.sequenceKey,
          shortcut,
        ]),
      ),
    [navigationShortcuts],
  );

  // Filter commands based on search
  const filteredCommands = commands.filter((command) => {
    const searchLower = search.toLowerCase();
    return (
      command.name.toLowerCase().includes(searchLower) ||
      command.description?.toLowerCase().includes(searchLower) ||
      command.keywords?.some((keyword) =>
        keyword.toLowerCase().includes(searchLower),
      )
    );
  });

  const searchInputRef = useRef<HTMLInputElement>(null);
  const navigationSequenceTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const awaitingNavigationKeyRef = useRef(false);

  // Dashboard-wide shortcuts are registered here because this component is
  // mounted once in the authenticated layout and already owns role-filtered
  // navigation.
  useEffect(() => {
    const clearNavigationSequence = () => {
      awaitingNavigationKeyRef.current = false;
      if (navigationSequenceTimerRef.current !== null) {
        clearTimeout(navigationSequenceTimerRef.current);
        navigationSequenceTimerRef.current = null;
      }
    };

    const startNavigationSequence = () => {
      clearNavigationSequence();
      awaitingNavigationKeyRef.current = true;
      navigationSequenceTimerRef.current = setTimeout(
        clearNavigationSequence,
        1000,
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const hasCommandModifier = e.metaKey || e.ctrlKey;

      if (hasCommandModifier && (key === "k" || key === "/")) {
        e.preventDefault();
        clearNavigationSequence();
        setIsOpen(true);
        if (key === "/") searchInputRef.current?.focus();
        return;
      }
      if (e.key === "Escape") {
        clearNavigationSequence();
        setIsOpen(false);
        return;
      }

      const target = e.target;
      const isTyping =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      const hasOtherModifier = e.metaKey || e.ctrlKey || e.altKey;
      const hasOpenDialog = document.querySelector(
        '[role="dialog"][aria-modal="true"]',
      );

      if (isTyping || hasOtherModifier || hasOpenDialog) {
        clearNavigationSequence();
        return;
      }

      if (awaitingNavigationKeyRef.current) {
        const shortcut = navigationShortcutByKey.get(key);
        clearNavigationSequence();
        if (shortcut) {
          e.preventDefault();
          router.push(shortcut.href);
        }
        return;
      }

      if (key === "g") {
        e.preventDefault();
        startNavigationSequence();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearNavigationSequence();
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [navigationShortcutByKey, router]);

  useEffect(() => {
    if (isOpen) searchInputRef.current?.focus();
  }, [isOpen]);

  // Handle command selection with keyboard
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  const handleKeyNavigation = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filteredCommands.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(
        (prev) =>
          (prev - 1 + filteredCommands.length) % filteredCommands.length,
      );
    } else if (e.key === "Enter" && filteredCommands[selectedIndex]) {
      e.preventDefault();
      filteredCommands[selectedIndex].action();
    }
  };

  return (
    <Transition show={isOpen} as={Fragment}>
      <Dialog onClose={setIsOpen} className="relative z-50">
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/50" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto p-4 pt-[10vh]">
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <Dialog.Panel className="mx-auto max-w-2xl transform overflow-hidden rounded-xl bg-card shadow-2xl ring-1 ring-black/5 transition-all">
              <div className="flex items-center border-b px-4">
                <SearchIcon className="w-5 h-5 text-muted-foreground mr-3" />
                <input
                  ref={searchInputRef}
                  type="text"
                  className="w-full border-0 py-4 text-lg placeholder-muted-foreground focus:outline-none focus:ring-0"
                  placeholder="Type a command or search..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={handleKeyNavigation}
                  autoFocus
                />
                <kbd className="ml-3 flex h-6 w-6 items-center justify-center rounded border border-border text-xs text-muted-foreground">
                  esc
                </kbd>
              </div>

              {filteredCommands.length > 0 ? (
                <ul className="max-h-80 scroll-py-2 overflow-y-auto py-2">
                  {filteredCommands.map((command, index) => (
                    <li
                      key={command.id}
                      role="option"
                      aria-selected={index === selectedIndex}
                      className={`mx-2 flex cursor-pointer select-none items-center rounded-md px-3 py-2 ${
                        index === selectedIndex
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-muted"
                      }`}
                      onClick={command.action}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          command.action();
                      }}
                      onMouseEnter={() => setSelectedIndex(index)}
                    >
                      <div className="mr-3 flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-muted">
                        {command.icon}
                      </div>
                      <div className="flex-auto">
                        <p className="text-sm font-medium">{command.name}</p>
                        {command.description && (
                          <p className="text-xs text-muted-foreground">
                            {command.description}
                          </p>
                        )}
                      </div>
                      {index === selectedIndex && (
                        <kbd className="ml-3 flex h-6 items-center rounded border border-border px-2 text-xs text-muted-foreground">
                          Enter
                        </kbd>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="py-14 px-6 text-center text-sm">
                  <p className="text-muted-foreground">No commands found.</p>
                </div>
              )}

              <div className="border-t px-4 py-2 text-xs text-muted-foreground">
                <span className="mr-2">Tip:</span>
                Use{" "}
                <kbd className="mx-1 rounded border border-border px-2 py-0.5">
                  ↑
                </kbd>
                <kbd className="mx-1 rounded border border-border px-2 py-0.5">
                  ↓
                </kbd>{" "}
                to navigate,
                <kbd className="mx-1 rounded border border-border px-2 py-0.5">
                  Enter
                </kbd>{" "}
                to select,
                <kbd className="mx-1 rounded border border-border px-2 py-0.5">
                  Esc
                </kbd>{" "}
                to close
              </div>
            </Dialog.Panel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition>
  );
}
