# Runtime-Role Cutover Drill — VH Health Platform

**Created 2026-06-14.** A staging **dry-run** that proves, against a real
Postgres, the load-bearing go-live step in
[`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md) **Phases
B / D / E**: the application connects as a `NOSUPERUSER NOBYPASSRLS` role
(`vhhealth_runtime`, member of `vhhealth_app`) so the `tenant_isolation` RLS
policies actually **enforce**, while the **migration Job runs as the owner**.

> This cutover had **never been rehearsed on a real DB** before this drill. The
> deterministic CI / QA path connects to its cluster as the `postgres`
> superuser, which silently masks the failure modes a real non-superuser cutover
> hits (see [Cutover risk surfaced](#cutover-risk-surfaced)). The drill is the
> first thing to exercise prod's true posture end-to-end.

- **Script:** [`apps/backend/scripts/runtime-role-cutover-drill.mjs`](../apps/backend/scripts/runtime-role-cutover-drill.mjs)
- **Companion runbooks:** [`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md) (Phases B/D/E), `PHASE0_OPERATOR_ACTIONS_2026-06-10.md` §1 + §8.

---

## What it proves

The drill stands up a throwaway database that mirrors the **production data +
role topology**, then asserts eight properties. All eight must pass for the
prod cutover to be considered de-risked.

| # | Check | Proves |
|---|---|---|
| 1 | **D2** migration chain applies clean as the (BYPASSRLS) owner | Every `src/migrations/*.sql` (incl. 309/310/311) applies with **zero** un-applied files under an owner-run migration pass — no `42501` / partial apply. |
| 2 | **D2** migration 310 is applied | `310_tenant_id_guc_default.sql` is recorded in `_migrations` (the GUC-reading `tenant_id` default is in place). |
| 3 | **E2** connection-role posture | The app's connection role `vhhealth_runtime` **and** the `SET LOCAL ROLE` target `vhhealth_app` are both `rolsuper=f rolbypassrls=f`. If either bypassed RLS, every policy would be silently inert. |
| 4 | **Ea** insert PHI under tenant A (clinical_ai_generations) | A tenant-scoped write succeeds and auto-scopes to tenant A. |
| 5 | **Ea** insert PHI under tenant A (appointments — migration 236 table) | The same holds for a **core, non-AI PHI table**, so the proof isn't limited to the `clinical_ai_*` family. |
| 6 | **Eb** cross-tenant read blocked | Under tenant B, tenant A's PHI row is **invisible** (RLS `USING` filters it). |
| 7 | **Ec** WITH CHECK rejects cross-tenant write | With GUC = tenant A but an explicit `tenant_id = B`, the INSERT is **rejected** (`42501`) and **nothing persists** (verified via a bypass read). |
| 8 | **Ed** migration 310 GUC-default | An INSERT that **omits** `tenant_id` under tenant B lands `tenant_id = B` (the GUC-reading default), **not** the literal default tenant — the bug 310 fixed. |

Checks 4–8 run **as `vhhealth_runtime`**, inside a transaction that issues
`SET LOCAL ROLE vhhealth_app` then `SELECT set_config('app.current_tenant_id',
…, true)` — exactly the shape `setTenant`/`setTenantTx` in
`src/lib/prisma.js` use in production.

---

## How to run

```bash
# From the repo root. Postgres must be up on 127.0.0.1:55432.
node apps/backend/scripts/runtime-role-cutover-drill.mjs
```

If Postgres on `:55432` is **not** up, bring the QA cluster up first — the drill
still uses its own scratch DB, never `vhhealth_test`:

```bash
node apps/backend/scripts/qa-cluster-up.mjs
node apps/backend/scripts/runtime-role-cutover-drill.mjs
```

**Safety / isolation guarantees:**

- The drill creates a **uniquely-named scratch DB** (`vhhealth_cutover_drill`,
  override with `--db=<name>`), `DROP DATABASE IF EXISTS` first.
- It **never** touches `vhhealth_test` or the dev cluster (port 5433). Safe to
  run while another agent is using `vhhealth_test`.
- The scratch DB is **torn down at the end and on failure** (including unexpected
  crashes — `main().catch` runs teardown too).
- It is **idempotent**: re-running is a clean fresh build each time.
- It does **not** drop the cluster-global roles it manages (`vhhealth`,
  `vhhealth_app`, `vhhealth_runtime`) — Postgres roles are not DB-scoped and the
  dev/QA cluster legitimately uses the `vhhealth` name. They are left
  `NOLOGIN`/`NOBYPASSRLS`, own no objects once the scratch DB is gone, and are
  re-used on the next run. Remove by hand if desired:
  `DROP ROLE IF EXISTS vhhealth_runtime, vhhealth_app;`

**Exit codes:** `0` = all checks PASS. `1` = at least one check FAILED (or the
RLS proof harness threw). `2` = Postgres on `:55432` unreachable.

---

## How to read the results

Each check prints a `[PASS]`/`[FAIL]` line with a one-line detail, then a summary
block. A clean run:

```
  [PASS] D2 migration chain applies clean as the (BYPASSRLS) owner — no 42501/partial apply — all 315 migration files applied (excl. 1 known-bad skip)
  [PASS] D2 migration 310 (GUC-reading tenant_id default) is applied — 310_tenant_id_guc_default.sql present in _migrations
  [PASS] E2 connection-role posture: vhhealth_runtime + vhhealth_app are NOSUPERUSER NOBYPASSRLS — current_user=vhhealth_runtime; both roles super=f bypassrls=f
  [PASS] Ea insert PHI under tenant A succeeds and scopes to A (clinical_ai_generations) — tenant_id=00000000-0000-4000-8000-000000000001
  [PASS] Ea insert PHI under tenant A succeeds and scopes to A (appointments — migration 236 table) — appointment id=1 tenant_id=00000000-0000-4000-8000-000000000001
  [PASS] Eb cross-tenant read blocked: tenant B cannot see tenant A PHI — tenant B sees only its own row (1 row[s], all tenant_id=B)
  [PASS] Ec WITH CHECK rejects cross-tenant write (GUC=A, explicit tenant_id=B) — rejected with 42501; no row persisted (verified via bypass)
  [PASS] Ed migration 310: INSERT omitting tenant_id under tenant B lands tenant_id=B (not literal default) — omitted tenant_id auto-scoped to B (00000000-0000-4000-8000-0000000000b2)
────────────────────────────────────────────────────────────
  8/8 checks passed
────────────────────────────────────────────────────────────

DRILL PASSED — non-superuser runtime role + RLS enforcement proven on a real DB.
```

**Interpreting failures:**

- **`Eb` fails (tenant B sees tenant A's row)** → the connection/effective role
  has `SUPERUSER`/`BYPASSRLS`, or the policy/`FORCE` is missing on that table.
  RLS is **not** enforcing — do **not** cut over. Cross-check `E2` and the boot
  guard `logTenantRlsRolePosture` (checklist E3).
- **`Ec` fails (cross-tenant write accepted)** → the `WITH CHECK` arm of the
  `tenant_isolation` policy isn't firing. Same root cause as `Eb`.
- **`Ed` fails (`tenant_id` defaulted to the literal default)** → migration 310
  did not take effect on that table; the `INSERT` will `42501` for any
  non-default tenant that omits `tenant_id`. Re-check check #2.
- **`D2` fails (some migrations un-applied)** → the migration chain did not apply
  clean under the owner posture. This is the [surfaced cutover risk](#cutover-risk-surfaced);
  read it before retrying.

---

## How each check maps to the prod cutover steps

The drill is a per-check rehearsal of the prod activation checklist. References
below are to [`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md).

### Phase B — Seal secrets (the runtime-role half)

- **B1** seals `vhhealth-pg-runtime` so CNPG's `managed.roles` reconciles the
  `vhhealth_runtime` password; **B2** points the backend `DATABASE_URL` at
  `vhhealth_runtime` and reserves `DATABASE_SUPERUSER_URL` for the migration Job.
- **Drill mapping:** the drill creates `vhhealth_runtime` (LOGIN, NOSUPERUSER,
  NOBYPASSRLS, member of `vhhealth_app`) and `vhhealth_app` (NOLOGIN) with the
  same grants, mirroring `infra/kubernetes/base/cnpg/cluster.yaml`
  (`managed.roles`) and `infra/kubernetes/overlays/dalekdefender/rls-runtime-role.sql`.
  It then **connects as `vhhealth_runtime`** — proving B2's `DATABASE_URL`
  identity is the one under which RLS must hold (checks **Ea–Ed**), and that its
  posture is correct (**E2**).

### Phase D — First sync / deploy (dependency-ordered)

- **D1** CNPG creates `vhhealth_runtime` with `enableSuperuserAccess:false`.
- **D2** the PreSync **migration Job** runs **all** `src/migrations/*.sql`
  (incl. **309/310/311**) using `DATABASE_SUPERUSER_URL` — the bootstrap owner.
- **D3** the backend rolls out connecting **as `vhhealth_runtime`**.
- **Drill mapping:** check **#1 (D2)** applies the entire migration chain via the
  same `ci-setup-db.mjs` runner under an **owner** connection — the analogue of
  the prod migration Job — and asserts **zero** un-applied files. Check
  **#2 (D2)** confirms **310** specifically landed. The drill's connect-as-runtime
  step is the D3 posture.

### Phase E — Verify RLS enforcement at runtime (the audit's #1 blocker)

- **E2** connection-role posture: `vhhealth_runtime` / `vhhealth_app` are
  `f`/`f` for `rolsuper`/`rolbypassrls`.
- **E5** the multi-tenant property the `cross-tenant-rls` CI journey asserts: a
  tenant-B token cannot read tenant-A PHI; an insert under tenant B lands
  `tenant_id = B` (migration 310).
- **Drill mapping:** check **E2** is the literal `pg_roles` posture query from
  E2 (run *through the runtime connection*, so it also proves the app connects as
  the right role). Checks **Eb / Ec / Ed** are the data-plane half of **E5**,
  run under the production `SET LOCAL ROLE` + GUC shape. (E1/E3/E4 are
  runtime-env / boot-log / dev-auth gates that only exist on a live deployment;
  they are covered by `logTenantRlsRolePosture` in `src/lib/prisma.js` and the
  `tenantRlsPosture` unit test, not by this DB-level drill.)

---

## Cutover risk surfaced

> **This is the headline finding the drill exists to surface. Treat it as a
> go-live blocker for any FRESH-cluster bring-up.**

**The migration chain cannot be applied by a `NOSUPERUSER NOBYPASSRLS` owner.**
Two facts collide:

1. `000_baseline.sql` is a `pg_dump --schema-only` and carries a **session-level**
   `SET row_security = off` (line 48). For a **non-superuser**, that flips RLS
   into *fail-loud* mode: any later statement that "would be affected by" an RLS
   policy raises `42501 query would be affected by row-level security policy`
   instead of transparently applying the policy.
2. Migrations **237** and **272** run `ALTER TABLE … FORCE ROW LEVEL SECURITY`,
   which removes the **owner's** RLS exemption. So once the baseline has run in
   the migration session, the next DDL/DML that touches a FORCE-RLS table under
   the non-superuser owner — e.g. **240**'s FK-add to `clinical_notes`, **255**'s
   `beds` seed — `42501`s, and `ci-setup-db.mjs`'s wrapping transaction then
   `25P02`-cascades the rest of the chain.

**Why it was never caught:** the deterministic CI / QA path
(`qa-cluster-up.mjs` → `ci-setup-db.mjs`) connects to the QA cluster **as the
`postgres` superuser**. Superusers ignore `row_security = off` and bypass RLS
entirely, so the chain applies clean there. On the QA cluster every table is
even **owned by `postgres`**, not by a `vhhealth` owner — so QA does not mirror
prod's role topology at all.

**Prod implication:** `cluster.yaml` runs the migration Job as the bootstrap
owner `vhhealth` with `enableSuperuserAccess:false`, and `managed.roles` does
**not** grant `vhhealth` superuser or `BYPASSRLS`. So a **fresh-cluster**
migration pass (checklist **D2**) — exactly the staging-first scenario D's note
recommends — will `42501` on first bring-up, leaving the schema **partially
migrated**. (An already-bootstrapped cluster is unaffected on subsequent deploys:
those migrations are tracked and skipped.)

**Recommended prod fix (pick one), to apply BEFORE the first D2 migration Job:**

- **Give the migrator role `BYPASSRLS`** for the apply. Either add a
  `managed.roles` entry for `vhhealth` with `bypassrls: true`, or introduce a
  dedicated `vhhealth_migrator` role (`LOGIN BYPASSRLS NOSUPERUSER`) and point
  `DATABASE_SUPERUSER_URL` at it. **The runtime role must stay `NOBYPASSRLS`.**
  *This is the option the drill rehearses:* it grants `BYPASSRLS` to the owner
  for the migration phase **only**, strips it immediately after, and then proves
  the runtime role (still `NOBYPASSRLS`) enforces RLS. Both halves pass.
- **OR** strip the leaked `SET row_security = off` from `000_baseline.sql`
  (regenerate the baseline without it, or append `SET row_security = on;` after
  the baseline applies). This removes the fail-loud trap so a plain owner can
  apply FORCE-RLS DDL. Higher blast radius (touches the baseline) and needs its
  own drift-check pass; the `BYPASSRLS`-migrator option is lower-risk.

**Secondary finding — extension prerequisites.** `000_baseline.sql` references
`public.vector` (pgvector) and other contrib types **without** a
`CREATE EXTENSION` of its own; it assumes `pgcrypto`/`pg_trgm`/`citext`/
`uuid-ossp`/`vector` already exist. In prod these come **before** the migration
Job from the pgvector-bearing CNPG image + `bootstrap.initdb.postInitApplicationSQL`.
`vector` is an **untrusted** extension, so only a **superuser** can create it —
the owner-run migration Job cannot. The drill provisions these as the superuser
before the migration pass (mirroring the operator-provisioned substrate);
confirm the prod CNPG image actually ships pgvector and that
`postInitApplicationSQL` (or an init step) creates `vector` before D2.

---

## Maintenance notes

- The drill uses two representative policied PHI tables: `clinical_ai_generations`
  (same table the `tenant-rls.deep.test.js` suite uses) and `appointments` (a
  core table policied by migration 236). If the policied-table set or the
  required-NOT-NULL columns on these tables change, update `seedFixtures()` and
  the `Ea` appointments insert accordingly.
- Tenant fixtures (`TENANT_A` = literal default, `TENANT_B`) match
  `tenant-rls.deep.test.js` so the two stay conceptually aligned.
- The drill is intentionally **not** wired into CI: it builds a full fresh DB
  (~315 migrations) and is a pre-go-live rehearsal, not a per-PR gate. Run it
  manually against a staging-class cluster before flipping the prod cutover, and
  re-run after any change to the migration chain, the role manifests, or the
  `tenant_isolation` policy set.
