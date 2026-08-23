"use client";

import { EmptyState } from "@/components/EmptyState";
import type { MigrationMappingProfile } from "@/lib/api/migrationToolkit";
import { JsonDetails, SectionCard, StatusPill, formatDateTime } from "./shared";

/** Read-only list; mapping profiles are managed via API/seed tooling. */
export function MappingProfilesPanel({
  profiles,
}: {
  profiles: MigrationMappingProfile[];
}) {
  return (
    <SectionCard title="Mapping profiles (read-only)">
      {profiles.length === 0 ? (
        <EmptyState
          compact
          title="No mapping profiles"
          description="Without a profile, rehearsals map columns by header name."
        />
      ) : (
        <div className="divide-y divide-border">
          {profiles.map((profile) => (
            <div key={profile.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-medium text-foreground">
                    {profile.profile_name}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    v{profile.version} · {profile.target_kind} ·{" "}
                    {profile.source_system ?? "any source"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill value={profile.status} />
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(profile.updated_at)}
                  </span>
                </div>
              </div>
              {profile.transform_notes && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {profile.transform_notes}
                </p>
              )}
              <div className="mt-2">
                <JsonDetails label="Field map" value={profile.field_map} />
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
