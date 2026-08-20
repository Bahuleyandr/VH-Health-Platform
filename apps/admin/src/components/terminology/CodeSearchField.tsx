// src/components/terminology/CodeSearchField.tsx
//
// Shared diagnosis-code typeahead (WP2). A plain text input with an
// additive suggestion dropdown fed by GET /terminology/search. Degrades to
// free text by design: when the search errors (proxy prefix not registered,
// feature dark), returns nothing (no content imported), or the field is
// disabled, the input behaves exactly like the free-text field it replaced —
// zero behavior change until terminology content exists.
//
// Two variants:
//   <CodeSearchField>       — single code (string value)
//   <CodeMultiSearchField>  — code list with removable chips (string[] value)

"use client";

import { useEffect, useRef, useState } from "react";
import {
  searchTerminology,
  type TerminologyConcept,
} from "@/lib/api/terminology";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

function useConceptSearch(system: string) {
  const [suggestions, setSuggestions] = useState<TerminologyConcept[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);

  function clear() {
    if (timer.current) clearTimeout(timer.current);
    requestSeq.current += 1;
    setSuggestions([]);
    setLoading(false);
  }

  function queueSearch(query: string) {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      clear();
      return;
    }
    timer.current = setTimeout(async () => {
      const seq = ++requestSeq.current;
      setLoading(true);
      try {
        const concepts = await searchTerminology({ q, system });
        if (seq !== requestSeq.current) return;
        setSuggestions(concepts);
      } catch {
        // Degrade to free text: swallow errors, show nothing.
        if (seq !== requestSeq.current) return;
        setSuggestions([]);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { suggestions, loading, queueSearch, clear };
}

function SuggestionList({
  suggestions,
  onPick,
}: {
  suggestions: TerminologyConcept[];
  onPick: (c: TerminologyConcept) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded border border-border bg-background shadow-lg">
      {suggestions.map((c) => (
        <button
          key={`${c.system_key}:${c.code}`}
          type="button"
          onMouseDown={(e) => {
            // onMouseDown beats the input's blur so the pick registers.
            e.preventDefault();
            onPick(c);
          }}
          className="block w-full px-2 py-1.5 text-left text-sm hover:bg-muted/40"
        >
          <span className="font-mono text-xs">{c.code}</span>
          {c.display ? <span className="ml-2">{c.display}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface CodeSearchFieldProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  /** Fires with the picked concept when a suggestion is chosen. */
  onConceptSelected?: (concept: TerminologyConcept) => void;
  system?: string;
  placeholder?: string;
  disabled?: boolean;
  labelClassName?: string;
  inputClassName?: string;
}

export function CodeSearchField({
  label,
  value,
  onChange,
  onConceptSelected,
  system = "ICD10",
  placeholder,
  disabled = false,
  labelClassName = "block text-xs uppercase tracking-wider text-muted-foreground mb-1",
  inputClassName = "w-full rounded border border-border bg-background px-2 py-1.5 text-sm",
}: CodeSearchFieldProps) {
  const { suggestions, loading, queueSearch, clear } = useConceptSearch(system);

  return (
    <div className="relative">
      {label ? <label className={labelClassName}>{label}</label> : null}
      <input
        type="text"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          if (!disabled) queueSearch(e.target.value);
        }}
        onBlur={() => clear()}
        className={inputClassName}
        aria-busy={loading || undefined}
      />
      <SuggestionList
        suggestions={disabled ? [] : suggestions}
        onPick={(c) => {
          onChange(c.code);
          onConceptSelected?.(c);
          clear();
        }}
      />
    </div>
  );
}

export interface CodeMultiSearchFieldProps {
  label?: string;
  values: string[];
  onChange: (values: string[]) => void;
  system?: string;
  placeholder?: string;
  disabled?: boolean;
  labelClassName?: string;
  inputClassName?: string;
}

export function CodeMultiSearchField({
  label,
  values,
  onChange,
  system = "ICD10",
  placeholder = "Type a code or diagnosis…",
  disabled = false,
  labelClassName = "block text-xs uppercase tracking-wider text-muted-foreground mb-1",
  inputClassName = "w-full rounded border border-border bg-background px-2 py-1.5 text-sm",
}: CodeMultiSearchFieldProps) {
  const [draft, setDraft] = useState("");
  const { suggestions, loading, queueSearch, clear } = useConceptSearch(system);

  function add(code: string) {
    const cleaned = code.trim();
    if (!cleaned) return;
    if (values.some((v) => v.toUpperCase() === cleaned.toUpperCase())) {
      setDraft("");
      clear();
      return;
    }
    onChange([...values, cleaned]);
    setDraft("");
    clear();
  }

  function remove(code: string) {
    onChange(values.filter((v) => v !== code));
  }

  return (
    <div className="relative">
      {label ? <label className={labelClassName}>{label}</label> : null}
      {values.length > 0 ? (
        <div className="mb-1 flex flex-wrap gap-1">
          {values.map((code) => (
            <span
              key={code}
              className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono text-xs"
            >
              {code}
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove ${code}`}
                  onClick={() => remove(code)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ✕
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      <input
        type="text"
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          if (!disabled) queueSearch(e.target.value);
        }}
        onKeyDown={(e) => {
          // Free-text entry path: Enter (or comma) commits the raw text as a
          // code even when the catalogue has nothing to offer.
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => {
          if (draft.trim()) add(draft);
          else clear();
        }}
        className={inputClassName}
        aria-busy={loading || undefined}
      />
      <SuggestionList
        suggestions={disabled ? [] : suggestions}
        onPick={(c) => add(c.code)}
      />
    </div>
  );
}
