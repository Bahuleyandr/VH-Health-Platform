"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  listImportJobs,
  listMappingProfiles,
} from "@/lib/api/migrationToolkit";
import { JobsPanel } from "./components/JobsPanel";
import { JobWorkspace } from "./components/JobWorkspace";
import { MappingProfilesPanel } from "./components/MappingProfilesPanel";

export default function MigrationToolkitPage() {
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);

  const jobsQuery = useQuery({
    queryKey: ["migration-toolkit", "jobs"],
    queryFn: () => listImportJobs({ limit: 100 }),
  });
  const profilesQuery = useQuery({
    queryKey: ["migration-toolkit", "mapping-profiles"],
    queryFn: () => listMappingProfiles({ limit: 100 }),
  });

  const jobs = jobsQuery.data?.jobs ?? [];
  const profiles = profilesQuery.data?.profiles ?? [];
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-teal-700">
            NL11-S1 Migration Toolkit
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-foreground">
            Legacy Data Migration
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Two-phase legacy imports: rehearse a dry run that produces a
            PHI-redacted report and writes nothing authoritative, then commit
            explicitly under an idempotency key. HL7 ADT batches commit in a
            single gated call.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void jobsQuery.refetch();
            void profilesQuery.refetch();
          }}
          className="inline-flex items-center gap-2 self-start rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {jobsQuery.isLoading ? (
        <LoadingSpinner label="Loading migration jobs..." />
      ) : jobsQuery.error instanceof Error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {jobsQuery.error.message}
        </div>
      ) : (
        <>
          <JobsPanel
            jobs={jobs}
            selectedJobId={selectedJobId}
            onSelect={setSelectedJobId}
          />
          {selectedJob && <JobWorkspace job={selectedJob} profiles={profiles} />}
          <MappingProfilesPanel profiles={profiles} />
        </>
      )}
    </div>
  );
}
