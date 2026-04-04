# VHHealth Database — Rebuild from Scratch Guide

> **Last updated:** 2026-04-04  
> **DB version:** PostgreSQL 15  
> **Current state:** 164 tables · 2,084 columns · 553 indexes · 0 errors  
> **DB size (dev data):** ~18 MB

This document is the single source of truth for rebuilding the VHHealth PostgreSQL database from zero. Follow it in order.

---

## Prerequisites

- PostgreSQL 15 running (Docker or managed service)
- A database and user created (see below)
- Backend repo cloned: `Bahuleyandr/vh-health-backend`

---

## Step 1 — Provision Database

### Docker (local / Pi)

```bash
docker run -d \
  --name vhhealth-db \
  -e POSTGRES_USER=vhhealth \
  -e POSTGRES_PASSWORD='VHHealth@2024' \
  -e POSTGRES_DB=vhhealth \
  -p 127.0.0.1:5433:5432 \
  --restart unless-stopped \
  postgres:15
```

### Managed service (Neon / Supabase / RDS / Railway)

Create a database, get the connection string. Set in `.env`:

```
DATABASE_URL=postgresql://user:pass@host:5432/vhhealth?sslmode=require
```

---

## Step 2 — Apply Prisma Migrations

Prisma manages the core 64 tables + billing/step tables via its own migration system.

```bash
cd vhhealth-backend
npm install
npx prisma migrate deploy
```

This applies:
- `20260330000002_add_step_rewards` — step_rewards, step_profiles, step_sessions  
- `20260402000001_add_billing_tables` — invoices, payment_transactions, insurance_claims

---

## Step 3 — Apply SQL Migrations (in order)

These migrations add the remaining 100+ tables, extended columns, and features. **Order matters.**

```bash
DB_URL="postgresql://vhhealth:VHHealth%402024@localhost:5433/vhhealth"

MIGRATIONS=(
  "002_investigations_notification.sql"
  "003_attendance_features.sql"
  "004_shift_overtime.sql"
  "005_incident_grievance.sql"
  "006_universal_audit_log.sql"
  "007_housekeeping.sql"
  "008_payroll.sql"
  "009_payroll_complete.sql"
  "010_payroll_compliance.sql"
  "011_appointment_records.sql"
  "012_appointment_improvements.sql"
  "013_investigation_enhancements.sql"
  "014_investigation_bookings.sql"
  "015_pharmacy_orders_enhanced.sql"
  "016_delivery_tracking.sql"
  "018_e_prescription.sql"
  "019_performance_indexes.sql"
  "020_missing_tables.sql"
  "021_schema_corrections.sql"
  "022_missing_emr_tables.sql"
  "023_missing_support_tables.sql"
  "024_column_corrections.sql"
  "025_sos_and_prisma_alignment.sql"
  "026_admins_missing_columns.sql"
  "add_invalidated_tokens.sql"
)

for f in "${MIGRATIONS[@]}"; do
  echo "Applying $f..."
  psql "$DB_URL" -f "migrations/$f"
done
```

> **Skip migration 017** (`017_seed_departments_doctors.sql`) — it has schema mismatches and is dev seed data only. Do not apply to production.

---

## Step 4 — Verify

```bash
# Should return 164
psql "$DB_URL" -tAc "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('_migrations','_prisma_migrations');"

# Should return 0
psql "$DB_URL" -tAc "SELECT COUNT(*) FROM pg_index WHERE NOT indisvalid;"

# Should return 0
psql "$DB_URL" -tAc "SELECT COUNT(*) FROM pg_constraint WHERE contype='f' AND NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=confrelid);"
```

Expected output: `164`, `0`, `0`

---

## Step 5 — Create First Admin

```bash
cd vhhealth-backend
node src/scripts/create-admin.js
```

Or via the API after the backend is running:

```bash
curl -X POST http://localhost:5000/api/v1/auth/admin/create-admin \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<strong-password>","email":"admin@vhhealth.app","role":"SUPER_ADMIN","permissions":["*"]}'
```

---

## Step 6 — (Optional) Load Reference Data

These tables benefit from seeded reference data on a fresh DB:

| Table | Content | Source |
|-------|---------|--------|
| `icd10_codes` | ~70k ICD-10 diagnosis codes | See `src/services/emr/icd10SeedData.js` |
| `departments` | Hospital department list | Migration 017 (fix schema first) or insert manually |
| `doctors` | Doctor profiles | Migration 017 or insert via admin portal |
| `leave_types` | Leave categories | Insert manually (ANNUAL, SICK, CASUAL, etc.) |
| `user_roles` | Role metadata | Auto-seeded by migration 024 (7 core roles) |
| `housekeeping_zones` | Hospital zones | Auto-seeded by migration 007 (14 zones) |
| `medications` | Drug formulary | Insert via admin portal or pharmacy catalog import |

---

## Alternative: Restore from Dump

If you have a pg_dump of an existing DB:

```bash
# Schema only (no data):
psql "$DB_URL" < docs/schema-dump.sql

# Full restore (schema + data):
pg_restore -d "$DB_URL" --no-owner --no-acl vhhealth-backup.dump
```

The file `docs/schema-dump.sql` in this repo is the canonical schema snapshot — updated after every migration batch.

---

## Connection String Reference

```
# Local Docker (Pi)
DATABASE_URL=postgresql://vhhealth:VHHealth%402024@localhost:5433/vhhealth

# Production template (replace with actual credentials)
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/vhhealth?sslmode=require
```

SSL is required for all managed services (Neon, Supabase, RDS, Railway). Prisma handles this automatically when `?sslmode=require` is in the URL.
