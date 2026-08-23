"use client";

import { Plus, Trash2 } from "lucide-react";
import {
  FILE_KINDS,
  type FileKind,
  type MigrationMappingProfile,
} from "@/lib/api/migrationToolkit";

export interface EditableFile {
  key: number;
  file_kind: FileKind;
  source_filename: string;
  csv_text: string;
  mapping_profile_id: string;
}

let nextKey = 1;

export function newEditableFile(): EditableFile {
  return {
    key: nextKey++,
    file_kind: "patient",
    source_filename: "",
    csv_text: "",
    mapping_profile_id: "",
  };
}

/**
 * Inline CSV source files for rehearsal AND commit. The backend takes the CSV
 * text in the JSON body both times — commit does not read back rehearsed rows,
 * so the same files must stay here for phase 2.
 */
export function SourceFilesEditor({
  files,
  onChange,
  profiles,
}: {
  files: EditableFile[];
  onChange: (files: EditableFile[]) => void;
  profiles: MigrationMappingProfile[];
}) {
  const update = (key: number, patch: Partial<EditableFile>) =>
    onChange(files.map((file) => (file.key === key ? { ...file, ...patch } : file)));

  return (
    <div className="space-y-3">
      {files.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Add at least one CSV source file to rehearse this job.
        </p>
      )}
      {files.map((file, index) => {
        const kindProfiles = profiles.filter(
          (profile) => profile.target_kind === file.file_kind && profile.status !== "archived",
        );
        return (
          <div key={file.key} className="rounded-md border border-border bg-background p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-xs font-medium text-muted-foreground">
                <span>File kind #{index + 1}</span>
                <select
                  className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
                  value={file.file_kind}
                  onChange={(e) =>
                    update(file.key, {
                      file_kind: e.target.value as FileKind,
                      mapping_profile_id: "",
                    })
                  }
                >
                  {FILE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                <span>Filename #{index + 1}</span>
                <input
                  className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
                  value={file.source_filename}
                  placeholder={`${file.file_kind}s.csv`}
                  onChange={(e) => update(file.key, { source_filename: e.target.value })}
                />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                <span>Mapping profile #{index + 1}</span>
                <select
                  className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
                  value={file.mapping_profile_id}
                  onChange={(e) => update(file.key, { mapping_profile_id: e.target.value })}
                >
                  <option value="">Auto (header-name mapping)</option>
                  {kindProfiles.map((profile) => (
                    <option key={profile.id} value={String(profile.id)}>
                      {profile.profile_name} v{profile.version}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-3 block text-xs font-medium text-muted-foreground">
              <span>CSV content #{index + 1}</span>
              <textarea
                className="mt-1 min-h-28 w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-xs"
                value={file.csv_text}
                placeholder={"header1,header2\nvalue1,value2"}
                onChange={(e) => update(file.key, { csv_text: e.target.value })}
              />
            </label>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => onChange(files.filter((f) => f.key !== file.key))}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
              >
                <Trash2 className="h-3 w-3" />
                Remove file
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...files, newEditableFile()])}
        className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
      >
        <Plus className="h-4 w-4" />
        Add source file
      </button>
    </div>
  );
}
