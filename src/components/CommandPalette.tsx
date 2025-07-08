// src/components/CommandPalette.tsx
'use client';

import { Fragment, useEffect, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';

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
  const [search, setSearch] = useState('');
  const router = useRouter();

  // Define available commands
  const commands: Command[] = [
    {
      id: 'go-dashboard',
      name: 'Go to Dashboard',
      description: 'Navigate to main dashboard',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
        </svg>
      ),
      action: () => {
        router.push('/dashboard');
        setIsOpen(false);
      },
      keywords: ['home', 'main', 'overview'],
    },
    {
      id: 'go-users',
      name: 'Go to Users',
      description: 'Manage users',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ),
      action: () => {
        router.push('/dashboard/users');
        setIsOpen(false);
      },
      keywords: ['patients', 'people', 'accounts'],
    },
    {
      id: 'go-doctors',
      name: 'Go to Doctors',
      description: 'Manage doctors',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      action: () => {
        router.push('/dashboard/doctors');
        setIsOpen(false);
      },
      keywords: ['physicians', 'medical', 'staff'],
    },
    {
      id: 'go-appointments',
      name: 'Go to Appointments',
      description: 'View appointments',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
      action: () => {
        router.push('/dashboard/appointments');
        setIsOpen(false);
      },
      keywords: ['calendar', 'schedule', 'bookings'],
    },
    {
      id: 'create-user',
      name: 'Create New User',
      description: 'Add a new user to the system',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
        </svg>
      ),
      action: () => {
        router.push('/dashboard/users?action=create');
        setIsOpen(false);
        toast.success('Opening create user form...');
      },
      keywords: ['add', 'new', 'patient'],
    },
    {
      id: 'generate-report',
      name: 'Generate Report',
      description: 'Create a new report',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
      action: () => {
        router.push('/dashboard/reporting');
        setIsOpen(false);
      },
      keywords: ['export', 'analytics', 'data'],
    },
    {
      id: 'toggle-theme',
      name: 'Toggle Dark Mode',
      description: 'Switch between light and dark theme',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      ),
      action: () => {
        document.documentElement.classList.toggle('dark');
        const isDark = document.documentElement.classList.contains('dark');
        localStorage.setItem('theme', isDark ? 'dark' : 'light');
        toast.success(`Switched to ${isDark ? 'dark' : 'light'} mode`);
        setIsOpen(false);
      },
      keywords: ['dark', 'light', 'theme', 'mode'],
    },
    {
      id: 'refresh-data',
      name: 'Refresh Current Page',
      description: 'Reload data on current page',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      ),
      action: () => {
        window.location.reload();
        setIsOpen(false);
      },
      keywords: ['reload', 'update', 'sync'],
    },
  ];

  // Filter commands based on search
  const filteredCommands = commands.filter((command) => {
    const searchLower = search.toLowerCase();
    return (
      command.name.toLowerCase().includes(searchLower) ||
      command.description?.toLowerCase().includes(searchLower) ||
      command.keywords?.some((keyword) => keyword.toLowerCase().includes(searchLower))
    );
  });

  // Keyboard shortcut to open command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen(true);
      }
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Handle command selection with keyboard
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  const handleKeyNavigation = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filteredCommands.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
    } else if (e.key === 'Enter' && filteredCommands[selectedIndex]) {
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
            <Dialog.Panel className="mx-auto max-w-2xl transform overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-black/5 transition-all">
              <div className="flex items-center border-b px-4">
                <svg className="w-5 h-5 text-gray-400 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  className="w-full border-0 py-4 text-lg placeholder-gray-400 focus:outline-none focus:ring-0"
                  placeholder="Type a command or search..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={handleKeyNavigation}
                  autoFocus
                />
                <kbd className="ml-3 flex h-6 w-6 items-center justify-center rounded border border-gray-300 text-xs text-gray-500">
                  esc
                </kbd>
              </div>

              {filteredCommands.length > 0 ? (
                <ul className="max-h-80 scroll-py-2 overflow-y-auto py-2">
                  {filteredCommands.map((command, index) => (
                    <li
                      key={command.id}
                      className={`mx-2 flex cursor-pointer select-none items-center rounded-md px-3 py-2 ${
                        index === selectedIndex ? 'bg-blue-50 text-blue-600' : 'hover:bg-gray-100'
                      }`}
                      onClick={command.action}
                      onMouseEnter={() => setSelectedIndex(index)}
                    >
                      <div className="mr-3 flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-gray-100">
                        {command.icon}
                      </div>
                      <div className="flex-auto">
                        <p className="text-sm font-medium">{command.name}</p>
                        {command.description && (
                          <p className="text-xs text-gray-500">{command.description}</p>
                        )}
                      </div>
                      {index === selectedIndex && (
                        <kbd className="ml-3 flex h-6 items-center rounded border border-gray-300 px-2 text-xs text-gray-500">
                          Enter
                        </kbd>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="py-14 px-6 text-center text-sm">
                  <p className="text-gray-500">No commands found.</p>
                </div>
              )}

              <div className="border-t px-4 py-2 text-xs text-gray-500">
                <span className="mr-2">Tip:</span>
                Use <kbd className="mx-1 rounded border border-gray-300 px-2 py-0.5">↑</kbd>
                <kbd className="mx-1 rounded border border-gray-300 px-2 py-0.5">↓</kbd> to navigate,
                <kbd className="mx-1 rounded border border-gray-300 px-2 py-0.5">Enter</kbd> to select,
                <kbd className="mx-1 rounded border border-gray-300 px-2 py-0.5">Esc</kbd> to close
              </div>
            </Dialog.Panel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition>
  );
}