"use client";

import { useEffect, useMemo, useState } from "react";
import { Bookmark, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type SavedTableViewState = Record<
  string,
  string | number | boolean | null | undefined
>;

type SavedView = {
  id: string;
  name: string;
  value: string;
  createdAt: string;
};

type StoredSavedView = SavedView & {
  query?: string;
};

function storageKey(scope: string) {
  return `vh.admin.tableViews.${scope}`;
}

function readViews(scope: string): SavedView[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(scope)) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((view: unknown): view is StoredSavedView =>
        Boolean(view && typeof view === "object" && "id" in view && "name" in view),
      )
      .map((view) => ({
        id: String(view.id),
        name: String(view.name),
        value: String(view.value ?? view.query ?? ""),
        createdAt: String(view.createdAt ?? new Date().toISOString()),
      }));
  } catch {
    return [];
  }
}

function writeViews(scope: string, views: SavedView[]) {
  window.localStorage.setItem(storageKey(scope), JSON.stringify(views));
}

function normalizeScope(scope: string) {
  return scope.replace(/[^\w.-]+/g, "_") || "dashboard";
}

function stableStateValue(state: SavedTableViewState) {
  const normalized = Object.fromEntries(
    Object.entries(state)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify(normalized);
}

function parseStateValue(value: string): SavedTableViewState {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as SavedTableViewState;
  } catch {
    return {};
  }
}

function SavedViewsControl({
  scope,
  label,
  currentValue,
  onApplyValue,
}: {
  scope: string;
  label: string;
  currentValue: string;
  onApplyValue: (value: string) => void;
}) {
  const resolvedScope = normalizeScope(scope);
  const [views, setViews] = useState<SavedView[]>([]);
  const [selected, setSelected] = useState("");

  useEffect(() => {
    setViews(readViews(resolvedScope));
  }, [resolvedScope]);

  const selectedView = useMemo(
    () => views.find((view) => view.id === selected),
    [selected, views],
  );

  const saveCurrentView = () => {
    const name = window.prompt("Saved view name");
    const trimmed = name?.trim();
    if (!trimmed) return;

    const nextView: SavedView = {
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`,
      name: trimmed,
      value: currentValue,
      createdAt: new Date().toISOString(),
    };
    const nextViews = [nextView, ...views.filter((view) => view.name !== trimmed)].slice(0, 12);
    writeViews(resolvedScope, nextViews);
    setViews(nextViews);
    setSelected(nextView.id);
  };

  const applyView = (viewId: string) => {
    setSelected(viewId);
    const view = views.find((item) => item.id === viewId);
    if (!view) return;
    onApplyValue(view.value);
  };

  const deleteSelected = () => {
    if (!selectedView) return;
    const nextViews = views.filter((view) => view.id !== selectedView.id);
    writeViews(resolvedScope, nextViews);
    setViews(nextViews);
    setSelected("");
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only">{label}</label>
      <select
        aria-label={label}
        value={selected}
        onChange={(event) => applyView(event.target.value)}
        className="rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
      >
        <option value="">Saved views</option>
        {views.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={saveCurrentView}
        className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-2 text-sm text-foreground hover:bg-muted"
      >
        <Bookmark className="h-4 w-4" />
        Save
      </button>
      <button
        type="button"
        onClick={deleteSelected}
        disabled={!selectedView}
        className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-2 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Trash2 className="h-4 w-4" />
        Delete
      </button>
    </div>
  );
}

export function ServerSavedViews({
  scope,
  label = "Saved views",
}: {
  scope?: string;
  label?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const resolvedScope = scope || pathname;

  return (
    <SavedViewsControl
      scope={resolvedScope}
      label={label}
      currentValue={searchParams.toString()}
      onApplyValue={(query) => {
        router.push(query ? `${pathname}?${query}` : pathname);
      }}
    />
  );
}

export function ClientSavedViews({
  scope,
  state,
  onApply,
  label = "Saved views",
}: {
  scope: string;
  state: SavedTableViewState;
  onApply: (state: SavedTableViewState) => void;
  label?: string;
}) {
  return (
    <SavedViewsControl
      scope={scope}
      label={label}
      currentValue={stableStateValue(state)}
      onApplyValue={(value) => onApply(parseStateValue(value))}
    />
  );
}
