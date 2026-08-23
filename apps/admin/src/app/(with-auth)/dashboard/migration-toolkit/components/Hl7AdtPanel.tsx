"use client";

import {
  importHl7AdtBatch,
  type Hl7AdtImportResult,
  type MigrationImportJob,
} from "@/lib/api/migrationToolkit";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileWarning } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

import { ConfirmDialog, JsonDetails, SectionCard, StatusPill } from "./shared";

function splitMessages(raw: string): string[] {
  return raw
    .split(/\n\s*\n/)
    .map((message) => message.trim())
    .filter(Boolean);
}

/**
 * HL7 ADT import. Unlike the CSV flow this endpoint is single-phase: parsing,
 * validation, and the authoritative commit all happen in the one call, so the
 * confirm dialog is the only gate.
 */
export function Hl7AdtPanel({ job }: { job: MigrationImportJob }) {
  const queryClient = useQueryClient();
  const [raw, setRaw] = useState("");
  const [sourceFilename, setSourceFilename] = useState("adt.hl7");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<Hl7AdtImportResult | null>(null);

  const messages = splitMessages(raw);

  const importMutation = useMutation({
    mutationFn: () =>
      importHl7AdtBatch(job.id, {
        messages,
        source_filename: sourceFilename.trim() || "adt.hl7",
      }),
    onSuccess: (res) => {
      setResult(res);
      setConfirmOpen(false);
      toast.success(`HL7 ADT batch #${res.hl7_batch.id} imported`);
      void queryClient.invalidateQueries({ queryKey: ["migration-toolkit"] });
    },
    onError: (err: Error) => {
      setConfirmOpen(false);
      toast.error(err.message || "HL7 ADT import failed");
    },
  });

  return (
    <SectionCard title="HL7 ADT import (single-phase commit)">
      <p className="text-sm text-muted-foreground">
        Paste ADT messages separated by a blank line. Warning: unlike the CSV
        flow there is no rehearsal step — validation and the live commit happen
        in one call, guarded only by the confirmation below and the batch
        idempotency key derived from the message content.
      </p>
      <div className="mt-3 grid gap-3">
        <label className="block text-xs font-medium text-muted-foreground">
          <span>ADT source filename</span>
          <input
            aria-label="ADT source filename"
            className="mt-1 w-64 rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={sourceFilename}
            onChange={(e) => setSourceFilename(e.target.value)}
          />
        </label>
        <label className="block text-xs font-medium text-muted-foreground">
          <span>HL7 ADT messages</span>
          <textarea
            aria-label="HL7 ADT messages"
            className="mt-1 min-h-32 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
            value={raw}
            placeholder={
              "MSH|^~\\&|LEGACY|...\nPID|1|...\nPV1|1|I|...\n\nMSH|^~\\&|LEGACY|..."
            }
            onChange={(e) => setRaw(e.target.value)}
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={messages.length === 0 || importMutation.isPending}
            onClick={() => setConfirmOpen(true)}
            className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            <FileWarning className="h-4 w-4" />
            Import {messages.length || ""} ADT message
            {messages.length === 1 ? "" : "s"}...
          </button>
        </div>
      </div>

      {result && (
        <div className="mt-4 space-y-2" data-testid="hl7-result">
          <div className="flex items-center gap-3 text-sm">
            <StatusPill value={result.hl7_batch.status} />
            <span className="text-xs text-muted-foreground">
              HL7 batch #{result.hl7_batch.id} · commit batch #{result.batch.id}
            </span>
          </div>
          {result.report && (
            <JsonDetails
              label="Acceptance summary"
              value={result.report.acceptance_summary}
            />
          )}
        </div>
      )}

      {confirmOpen && (
        <ConfirmDialog
          destructive
          title="Import HL7 ADT batch into live tables?"
          body={
            <>
              <p>
                This imports {messages.length} ADT message
                {messages.length === 1 ? "" : "s"} for job #{job.id} and{" "}
                <strong>
                  commits patients and encounters to live tables in this single
                  call
                </strong>{" "}
                — there is no separate rehearsal for HL7 ADT.
              </p>
              <p>
                Validation errors in any message block the whole batch. Replays
                of identical content are deduplicated by idempotency key.
              </p>
            </>
          }
          confirmLabel="Import and commit"
          pending={importMutation.isPending}
          onConfirm={() => importMutation.mutate()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </SectionCard>
  );
}
