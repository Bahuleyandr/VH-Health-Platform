// src/app/(with-auth)/dashboard/icu/components/BundleTab.tsx

"use client";

import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { IcuBundle, unwrap } from "./types";

const TODAY = () => new Date().toISOString().slice(0, 10);

export default function BundleTab({ admissionId }: { admissionId: number }) {
  const qc = useQueryClient();
  const [day, setDay] = useState<string>(TODAY());

  const { data: bundle, isLoading } = useQuery<IcuBundle | null>({
    queryKey: ["icu", "bundle", admissionId, day],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        `/icu/admissions/${admissionId}/bundle?bundle_date=${day}`,
      );
      const data = unwrap<IcuBundle | null>(r);
      return data ?? null;
    },
  });

  const [form, setForm] = useState<Partial<IcuBundle>>({});

  // Sync form when server bundle arrives.
  useEffect(() => {
    if (bundle) {
      setForm(bundle);
    } else {
      setForm({});
    }
  }, [bundle]);

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/icu/admissions/${admissionId}/bundle`,
      {
        method: "POST",
        body: JSON.stringify({ bundle_date: day, ...form }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["icu", "bundle"] });
    },
  });

  const setF = <K extends keyof IcuBundle>(k: K, v: IcuBundle[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const elements = [
    {
      key: "a", letter: "A", label: "Awakening trial",
      done: form.a_awakening_done, setDone: (v: boolean) => setF("a_awakening_done", v),
      reasonField: "a_awakening_reason_skipped" as const,
      reason: form.a_awakening_reason_skipped,
      setReason: (v: string) => setF("a_awakening_reason_skipped", v),
    },
    {
      key: "b", letter: "B", label: "Spontaneous breathing trial",
      done: form.b_breathing_done, setDone: (v: boolean) => setF("b_breathing_done", v),
      reasonField: "b_breathing_reason_skipped" as const,
      reason: form.b_breathing_reason_skipped,
      setReason: (v: string) => setF("b_breathing_reason_skipped", v),
    },
    {
      key: "c", letter: "C", label: "Choice of analgesia + sedation",
      done: form.c_choice_done, setDone: (v: boolean) => setF("c_choice_done", v),
    },
    {
      key: "d", letter: "D", label: "Delirium assess + manage",
      done: form.d_delirium_assessed, setDone: (v: boolean) => setF("d_delirium_assessed", v),
    },
    {
      key: "e", letter: "E", label: "Early mobility / exercise",
      done: form.e_mobility_done, setDone: (v: boolean) => setF("e_mobility_done", v),
      reasonField: "e_mobility_reason_skipped" as const,
      reason: form.e_mobility_reason_skipped,
      setReason: (v: string) => setF("e_mobility_reason_skipped", v),
    },
    {
      key: "f", letter: "F", label: "Family engagement",
      done: form.f_family_done, setDone: (v: boolean) => setF("f_family_done", v),
    },
  ];

  const localDone = elements.filter((e) => e.done).length;
  const localPct = Math.round(100 * localDone / 6);
  const localComplete = localDone === 6;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label className="text-sm text-muted-foreground">Date:</label>
        <input
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1 text-sm"
        />
      </div>

      {isLoading && <LoadingSpinner />}

      {!isLoading && (
        <>
          <div
            className={`rounded-lg border p-4 text-center ${
              localComplete
                ? "border-emerald-500/40 bg-emerald-500/10"
                : "border-amber-500/40 bg-amber-500/10"
            }`}
          >
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Bundle compliance for {day}
            </div>
            <div className="text-3xl font-semibold mt-1">
              {localDone} / 6 elements ({localPct}%)
            </div>
            <div className="text-sm mt-1">
              {localComplete ? "✓ Bundle complete (all-or-nothing)" : "Bundle incomplete"}
            </div>
          </div>

          <div className="space-y-3">
            {elements.map((el) => (
              <div
                key={el.key}
                className={`rounded-lg border p-4 ${
                  el.done
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : "border-border"
                }`}
              >
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(el.done)}
                    onChange={(e) => el.setDone(e.target.checked)}
                    className="mt-1 size-4"
                  />
                  <div className="flex-1">
                    <div className="font-semibold">
                      <span className="inline-block w-6 h-6 rounded-full bg-primary text-primary-foreground text-center text-sm leading-6 mr-2">
                        {el.letter}
                      </span>
                      {el.label}
                    </div>

                    {el.key === "b" && (
                      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                        <select
                          value={form.b_breathing_outcome ?? ""}
                          onChange={(e) => setF("b_breathing_outcome", e.target.value || null)}
                          className="rounded border border-border bg-background px-2 py-1 text-sm"
                        >
                          <option value="">Outcome…</option>
                          <option value="extubated">Extubated</option>
                          <option value="tolerated">Tolerated</option>
                          <option value="failed">Failed</option>
                          <option value="na">N/A</option>
                        </select>
                      </div>
                    )}

                    {el.key === "c" && (
                      <label className="flex items-center gap-2 mt-2 text-sm">
                        <input
                          type="checkbox"
                          checked={Boolean(form.c_protocol_followed)}
                          onChange={(e) => setF("c_protocol_followed", e.target.checked)}
                        />
                        Hospital protocol followed
                      </label>
                    )}

                    {el.key === "d" && (
                      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={Boolean(form.d_delirium_positive)}
                            onChange={(e) => setF("d_delirium_positive", e.target.checked)}
                          />
                          CAM-ICU positive
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={Boolean(form.d_delirium_managed)}
                            onChange={(e) => setF("d_delirium_managed", e.target.checked)}
                          />
                          Non-pharm + pharm steps
                        </label>
                      </div>
                    )}

                    {el.key === "e" && (
                      <select
                        value={form.e_mobility_level ?? ""}
                        onChange={(e) => setF("e_mobility_level", e.target.value || null)}
                        className="mt-2 rounded border border-border bg-background px-2 py-1 text-sm"
                      >
                        <option value="">Mobility level…</option>
                        <option value="passive_rom">Passive ROM</option>
                        <option value="active_rom">Active ROM</option>
                        <option value="sit_edge">Sit at edge of bed</option>
                        <option value="stand">Stand</option>
                        <option value="walk">Walk</option>
                        <option value="na">N/A</option>
                      </select>
                    )}

                    {el.key === "f" && (
                      <select
                        value={form.f_family_method ?? ""}
                        onChange={(e) => setF("f_family_method", e.target.value || null)}
                        className="mt-2 rounded border border-border bg-background px-2 py-1 text-sm"
                      >
                        <option value="">Method…</option>
                        <option value="rounds_at_bedside">Bedside rounds</option>
                        <option value="video_call">Video call</option>
                        <option value="in_person_meeting">In-person meeting</option>
                        <option value="phone">Phone</option>
                      </select>
                    )}

                    {!el.done && el.reasonField && (
                      <input
                        type="text"
                        placeholder="Reason skipped (mandatory if not done)"
                        value={el.reason ?? ""}
                        onChange={(e) => el.setReason!(e.target.value)}
                        className="mt-2 w-full rounded border border-amber-500/30 bg-background px-2 py-1 text-sm"
                      />
                    )}
                  </div>
                </label>
              </div>
            ))}
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Notes (handover for next shift)
            </label>
            <textarea
              rows={3}
              value={form.notes ?? ""}
              onChange={(e) => setF("notes", e.target.value)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
            />
          </div>

          {m.error instanceof Error && (
            <div className="text-sm text-rose-400">{m.error.message}</div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => m.mutate()}
              disabled={m.isPending}
              className="rounded bg-primary px-6 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {m.isPending ? "Saving…" : bundle ? "Update bundle" : "Save bundle"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
