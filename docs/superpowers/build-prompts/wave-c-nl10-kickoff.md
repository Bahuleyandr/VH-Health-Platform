# DESIGN: NL-10 kickoff — Embedded BI (self-serve analytics, governed catalog, exec digest)

Docs-only design session. Deliverable: ONE grounded spec at `docs/superpowers/specs/<today>-nl10-embedded-bi-design.md` as a docs-only PR. NO code.

**Program (roadmap §5 NL-10):** deploy + embed self-serve analytics (Metabase/Superset on the dbt marts; `metabaseService` seam), governed dataset catalog, exec mobile digest, benchmark pack.

## Method (Wave B discipline)
1. **Survey first, cite `path:line`.** Ground: `metabaseService` seam (what it actually wires today), dbt marts inventory (models, refresh), `prismaReadOnly`/read-replica posture (DATABASE_READ_URL placeholder state), existing dashboards (admin realtime boards vs analytical), export rails, tierH/analytics AI modules, multi-tenant RLS implications for BI (this is THE hard problem — a BI tool with a direct DB connection bypasses app-layer tenancy; design the tenant-isolation model: per-tenant DB creds vs row-level filters vs mart-level tenant splits), k8s footprint for a Metabase/Superset deployment (deploy HELD — manifests unreferenced).
2. **Boundaries:** NL-12 owns SIEM/audit export; NL-11 owns the public developer portal; exec mobile digest rides existing notification rails (NL-9 adjacency — name the seam).
3. **Structure:** invariants (tenant isolation FIRST-CLASS, PHI minimization in marts, deploy HELD) → existing substrate (verified) → tool decision matrix (Metabase vs Superset vs embed-only — with a recommendation) → tenancy/security design → phased plan with migration counts → test strategy → **Owner Decisions** (tool choice sign-off, mart PHI policy, benchmark data sharing posture) → source notes.
4. **Isolation:** worktree per `_worker-common.md`, branch `docs/nl10-embedded-bi-design`, single-file PR, stop after PR.

## Kickoff line
> You are a design worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\wave-c-nl10-kickoff.md` and `_worker-common.md` beside it; produce the NL-10 design spec exactly as instructed (survey-grounded, docs-only, single-file PR, stop after PR).
