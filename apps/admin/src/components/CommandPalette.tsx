// src/components/CommandPalette.tsx
"use client";

import { Fragment, useEffect, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import {
  HomeIcon,
  UsersIcon,
  UserIcon,
  CalendarIcon,
  PlusIcon,
  FileTextIcon,
  MoonIcon,
  RefreshIcon,
  SearchIcon,
} from "@/components/icons";

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

  // Define available commands
  const commands: Command[] = [
    {
      id: "go-dashboard",
      name: "Go to Dashboard",
      description: "Navigate to main dashboard",
      icon: <HomeIcon className="w-5 h-5" />,
      action: () => {
        router.push("/dashboard");
        setIsOpen(false);
      },
      keywords: ["home", "main", "overview"],
    },
    {
      id: "go-users",
      name: "Go to Users",
      description: "Manage users",
      icon: <UsersIcon className="w-5 h-5" />,
      action: () => {
        router.push("/dashboard/users");
        setIsOpen(false);
      },
      keywords: ["patients", "people", "accounts"],
    },
    {
      id: "go-doctors",
      name: "Go to Doctors",
      description: "Manage doctors",
      icon: <UserIcon className="w-5 h-5" />,
      action: () => {
        router.push("/dashboard/doctors");
        setIsOpen(false);
      },
      keywords: ["physicians", "medical", "staff"],
    },
    {
      id: "go-appointments",
      name: "Go to Appointments",
      description: "View appointments",
      icon: <CalendarIcon className="w-5 h-5" />,
      action: () => {
        router.push("/dashboard/appointments");
        setIsOpen(false);
      },
      keywords: ["calendar", "schedule", "bookings"],
    },
    {
      id: "create-user",
      name: "Create New User",
      description: "Add a new user to the system",
      icon: <PlusIcon className="w-5 h-5" />,
      action: () => {
        router.push("/dashboard/users?action=create");
        setIsOpen(false);
        toast.success("Opening create user form...");
      },
      keywords: ["add", "new", "patient"],
    },
    {
      id: "generate-report",
      name: "Generate Report",
      description: "Create a new report",
      icon: <FileTextIcon className="w-5 h-5" />,
      action: () => {
        router.push("/dashboard/reporting");
        setIsOpen(false);
      },
      keywords: ["export", "analytics", "data"],
    },
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

  // Keyboard shortcut to open command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsOpen(true);
      }
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

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
