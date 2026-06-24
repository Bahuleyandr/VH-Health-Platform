"use client";

import { ReactNode, useState } from "react";

export function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between bg-muted px-4 py-2 font-medium text-sm hover:bg-muted/80"
      >
        <span>{title}</span>
        <span className="text-muted-foreground" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && <div className="p-4">{children}</div>}
    </section>
  );
}
