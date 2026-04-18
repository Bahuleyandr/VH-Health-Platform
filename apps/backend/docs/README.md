# VHHealth Backend — Documentation Index

| Document | Purpose |
|----------|---------|
| [`DB-REBUILD-GUIDE.md`](./DB-REBUILD-GUIDE.md) | **Start here if rebuilding from scratch.** Step-by-step: provision DB, apply Prisma migrations, apply SQL migrations, verify, create first admin. |
| [`DB-MIGRATION-MANIFEST.md`](./DB-MIGRATION-MANIFEST.md) | Every migration file, what it does, current status, and audit log of when/why changes were made. |
| [`DB-SCHEMA-REFERENCE.md`](./DB-SCHEMA-REFERENCE.md) | Full table inventory — all 164 tables grouped by domain, column counts, key column notes, known gaps. |
| [`DB-MIGRATION-PLAN.md`](./DB-MIGRATION-PLAN.md) | Plan for moving off Pi to production managed DB (Neon/Supabase/RDS/Railway). |
| [`schema-dump.sql`](./schema-dump.sql) | Live schema-only pg_dump — canonical SQL snapshot of all 164 tables. Use for restore or diff. |
| [`DB-CROSS-REPO-AUDIT.md`](../DB-CROSS-REPO-AUDIT.md) | Cross-repo audit report (all 5 GitHub repos). |

---

## Current DB State (2026-04-04)

```
Host:       127.0.0.1:5433 (Docker vhhealth-db, postgres:15)
Database:   vhhealth
Tables:     164
Columns:    2,084
Indexes:    553
FK errors:  0
Invalid indexes: 0
DB size:    ~18 MB (dev data only)
```

## DB Access

```
# Local / Pi
DATABASE_URL=postgresql://vhhealth:<local-db-password-urlencoded>@localhost:5433/vhhealth
docker exec vhhealth-db psql -U vhhealth -d vhhealth
```
