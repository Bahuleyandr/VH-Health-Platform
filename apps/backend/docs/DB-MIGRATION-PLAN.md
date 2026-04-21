# VHHealth Database — Production Migration Plan
> **Purpose:** Move from Raspberry Pi (Docker) to a managed commercial PostgreSQL service  
> **Drafted:** 2026-04-04  
> **Last updated:** 2026-04-04  
> **Status:** Planning — not yet executed

> **Pre-requisite completed:** DB fully validated and all migrations applied (164 tables, 0 errors). Schema dump available at `docs/schema-dump.sql`. Rebuild guide at `docs/DB-REBUILD-GUIDE.md`.

---

## Why Move Off the Pi

| Risk | Detail |
|------|--------|
| **Hardware failure** | Pi SD cards have finite write cycles; no RAID, no automatic failover |
| **No HA** | Single point of failure — Pi goes down, entire backend goes down |
| **Throughput ceiling** | Pi 5 ARM CPU + SD I/O will bottleneck under real patient load |
| **Backup complexity** | Manual Docker volume backups — no point-in-time recovery |
| **Network exposure** | Pi sits on home/office network; production DB should be on isolated cloud infra |
| **Compliance posture** | For any DPDP Act / HIPAA-like posture, you want managed infrastructure with audit trails, encryption at rest, and SLA guarantees |

---

## Target Options

### Option A — Neon (Recommended for current stage)
- **Type:** Serverless Postgres (scale to zero)
- **Why:** Free tier generous, auto-scaling, built-in branching for dev/staging, Prisma-native
- **Connection:** Standard PostgreSQL URL — zero code changes
- **Pricing:** Free up to 512 MB, then $19/mo for 10 GB
- **Backup:** 7-day PITR on paid, daily on free
- **Latency from India:** ~80-120ms to EU/US, ~30-50ms if using `ap-southeast-1`
- **Best for:** Pre-launch / early production (< 1000 patients)

### Option B — Supabase
- **Type:** Managed Postgres + auth + storage
- **Why:** Good free tier, India region available (ap-south-1 Mumbai)
- **Pricing:** Free up to 500 MB, then $25/mo
- **Backup:** 7-day PITR on Pro plan
- **Latency from India:** ~10-20ms (Mumbai region)
- **Consideration:** Supabase wraps Postgres — you can still use Prisma directly
- **Best for:** If you later want to leverage Supabase auth/storage alongside DB

### Option C — AWS RDS (PostgreSQL 15)
- **Type:** Managed cloud RDS
- **Why:** Production-grade, multi-AZ, automated backups, Mumbai region
- **Pricing:** `db.t4g.micro` ~$15-20/mo, storage ~$0.115/GB/mo
- **Backup:** Automated + manual snapshots, 35-day retention max
- **Latency:** ~5-10ms if VHHealth backend moves to EC2/Lightsail in same region
- **Best for:** Scaling past 1000+ patients, if deploying backend to AWS too

### Option D — Railway
- **Type:** Managed Postgres (PostgreSQL 15)
- **Why:** Dead simple, great DX, production-capable
- **Pricing:** $5/mo + usage, very predictable
- **Backup:** Automated daily backups
- **Best for:** Quick production move with minimal ops overhead

---

## Recommendation

**Short-term (launch → first 6 months):** Neon or Railway  
**Medium-term (> 500 patients or commercial launch):** Supabase (Mumbai) or RDS

All four services use standard PostgreSQL — migration between them later is straightforward.

---

## Migration Steps

### Phase 1 — Preparation (before cutover)

- [ ] Resolve known schema issues (see `DB-SCHEMA-REFERENCE.md` — Known Issues)
  - Fix `patient_id` column inconsistency across investigations/pharmacy_orders
  - Fix `notifications.user_id` vs `uid` mismatch in migration 019
  - Add `retry_count` + `last_attempt_at` to `notification_outbox` if retry logic needed
  - Fix migration 017 seed (schema mismatches in departments/doctors)
- [ ] Consolidate `audit_log` vs `audit_logs` — decide which is canonical
- [ ] Create a combined init script: `scripts/db-init-full.sh` that runs Prisma migrate + all SQL migrations in order (so a fresh DB can be spun up reproducibly)
- [ ] Set up automated backups of Pi DB until cutover (daily Docker volume backup to object storage)

### Phase 2 — Provision Target

```bash
# Example: Neon
# 1. Create project at neon.tech
# 2. Get connection string: postgresql://<user>:<password>@<host>/<database>?sslmode=require
# 3. Set as DATABASE_URL in production env

# Example: Railway
# railway add --plugin postgresql
# railway variables  # get DATABASE_URL
```

### Phase 3 — Schema Migration (fresh apply on target)

```bash
# On production machine, pointing at new DB URL:
export DATABASE_URL="postgresql://new-host/vhhealth?sslmode=require"

# Apply Prisma migrations
cd vhhealth-backend
npx prisma migrate deploy

# Apply SQL migrations in order
for f in migrations/002_investigations_notification.sql \
          migrations/003_attendance_features.sql \
          migrations/004_shift_overtime.sql \
          migrations/005_incident_grievance.sql \
          migrations/006_universal_audit_log.sql \
          migrations/007_housekeeping.sql \
          migrations/008_payroll.sql \
          migrations/009_payroll_complete.sql \
          migrations/010_payroll_compliance.sql \
          migrations/011_appointment_records.sql \
          migrations/012_appointment_improvements.sql \
          migrations/013_investigation_enhancements.sql \
          migrations/014_investigation_bookings.sql \
          migrations/015_pharmacy_orders_enhanced.sql \
          migrations/016_delivery_tracking.sql \
          migrations/018_e_prescription.sql \
          migrations/019_performance_indexes.sql \
          migrations/020_missing_tables.sql \
          migrations/add_invalidated_tokens.sql; do
  echo "Applying $f..."
  psql "$DATABASE_URL" -f "$f"
done
```

> Skip migration 017 (seed) — do not seed production from dev seed data.

### Phase 4 — Data Migration (Pi → Target)

```bash
# 1. Take final Pi dump
docker exec vhhealth-db pg_dump -U vhhealth -d vhhealth \
  --no-owner --no-acl \
  --exclude-table='_prisma_migrations' \
  --exclude-table='_migrations' \
  -f /tmp/vhhealth-prod-$(date +%Y%m%d).sql

# Copy dump out
docker cp vhhealth-db:/tmp/vhhealth-prod-*.sql ./backups/

# 2. Restore to target (skip if starting fresh — pre-launch with no real patient data)
psql "$DATABASE_URL" < backups/vhhealth-prod-<date>.sql
```

> **If pre-launch with no real patient data:** Skip the dump/restore entirely. Fresh schema apply is cleaner.

### Phase 5 — Backend Cutover

```bash
# Update backend environment
# In ecosystem.config.cjs or .env.production:
DATABASE_URL=postgresql://new-host/vhhealth?sslmode=require

# Restart backend
pm2 restart vhhealth-backend

# Verify
curl http://localhost:5000/api/health
```

### Phase 6 — Verification

- [ ] All 111 tables present on target
- [ ] Backend health check returns 200
- [ ] OTP flow works end to end
- [ ] Appointment booking works
- [ ] Staff auth works
- [ ] Admin portal login works
- [ ] File upload/download works

### Phase 7 — Decommission Pi DB

- [ ] Keep Pi DB running for 2 weeks as cold fallback
- [ ] After 2 weeks stable: stop `vhhealth-db` container
- [ ] Final dump archived to cold storage
- [ ] Remove DB from Pi `docker-compose.yml`

---

## SSL / Security Requirements

All managed services require SSL. Backend must connect with `?sslmode=require`. Prisma handles this automatically when the connection string includes it.

No application code changes needed for the move — only the `DATABASE_URL` env var changes.

---

## Estimated Timeline

| Phase | Time |
|-------|------|
| Resolve schema issues | 1-2 days |
| Create combined init script | 2 hours |
| Provision + apply schema to target | 1 hour |
| Data migration (if needed) | 30 min |
| Backend cutover + verification | 1-2 hours |
| Monitor + Pi decommission | 2 weeks |

Total active work: **1-2 days** (mostly prep). Cutover itself is under 4 hours.

---

## Rollback Plan

If cutover fails:
1. Revert `DATABASE_URL` to Pi connection string
2. Restart backend — fully restored in < 5 minutes
3. Pi DB untouched throughout — zero risk to existing data
