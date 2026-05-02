// src/services/bed/bedService.js
import prisma from '../../lib/prisma.js';

const BED_RETURNING = `id, ward_id, bed_number, status, patient_id, patient_name,
    admitted_at, notes, assigned_at, created_at, updated_at`;
const WARD_RETURNING = `id, name, floor, department_id, total_beds, created_at, updated_at`;

class BedService {
  // ===== WARD OPERATIONS =====

  async listWards() {
    return prisma.$queryRawUnsafe(`
      SELECT w.*, d.name as department_name,
        (SELECT COUNT(*)::int FROM beds b WHERE b.ward_id = w.id) as bed_count,
        (SELECT COUNT(*)::int FROM beds b WHERE b.ward_id = w.id AND b.status = 'occupied') as occupied_count
      FROM wards w
      LEFT JOIN departments d ON w.department_id = d.id
      ORDER BY w.name
    `);
  }

  async createWard(data) {
    const { name, floor, department_id, total_beds } = data;
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, department_id, total_beds)
       VALUES ($1, $2, $3, $4)
       RETURNING ${WARD_RETURNING}`,
      name, floor || 1, department_id || null, total_beds || 0
    );
    return rows[0];
  }

  async updateWard(id, data) {
    const { name, floor, department_id, total_beds } = data;
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE wards SET
         name = COALESCE($1, name),
         floor = COALESCE($2, floor),
         department_id = COALESCE($3, department_id),
         total_beds = COALESCE($4, total_beds),
         updated_at = NOW()
       WHERE id = $5
       RETURNING ${WARD_RETURNING}`,
      name ?? null, floor ?? null, department_id ?? null, total_beds ?? null, parseInt(id)
    );
    return rows[0];
  }

  async deleteWard(id) {
    const count = await prisma.$executeRawUnsafe(
      `DELETE FROM wards WHERE id = $1`, parseInt(id));
    return count > 0;
  }

  // ===== BED OPERATIONS =====

  async listBeds() {
    return prisma.$queryRawUnsafe(`
      SELECT b.*, w.name as ward_name, w.floor as ward_floor
      FROM beds b
      LEFT JOIN wards w ON b.ward_id = w.id
      ORDER BY w.name, b.bed_number
    `);
  }

  async getBedsByWard(wardId) {
    // Pull patient + admission context alongside the bed so the bed-board
    // detail sheet can render name + age + gender + admission reason +
    // attending doctor without an N+1 round trip per bed. Joins are LEFT
    // joins so empty/maintenance beds still come back; cross-prefer
    // `beds.admission_id` (the explicit FK) and fall back to "the active
    // admission for this patient_uid" when the id wasn't backfilled.
    return prisma.$queryRawUnsafe(
      `SELECT b.*,
              w.name AS ward_name,
              u.name      AS patient_full_name,
              u.gender    AS patient_gender,
              u.dob       AS patient_dob,
              u.phone     AS patient_phone,
              -- Years of age is the column most callers want; compute
              -- in SQL to keep the wire payload trivial.
              CASE WHEN u.dob IS NOT NULL
                   THEN DATE_PART('year', AGE(u.dob))::int
              END         AS patient_age,
              a.id        AS admission_id_resolved,
              a.chief_complaint,
              a.admitting_diagnosis,
              a.admission_type,
              a.priority  AS admission_priority,
              a.admitted_at AS admission_admitted_at,
              a.attending_doctor AS attending_doctor_uid,
              doc.name    AS attending_doctor_name
       FROM beds b
       LEFT JOIN wards w
         ON b.ward_id = w.id
       LEFT JOIN users u
         ON b.patient_uid = u.uid
       LEFT JOIN admissions a
         ON (b.admission_id IS NOT NULL AND a.id = b.admission_id)
         OR (b.admission_id IS NULL AND a.patient_uid = b.patient_uid AND a.discharged_at IS NULL)
       LEFT JOIN users doc
         ON doc.uid = a.attending_doctor
       WHERE b.ward_id = $1
       ORDER BY b.bed_number`,
      parseInt(wardId)
    );
  }

  async getBedSummary() {
    return prisma.$queryRawUnsafe(`
      SELECT w.id as ward_id, w.name as ward_name, w.floor, w.total_beds,
        COUNT(b.id)::int as actual_beds,
        COUNT(b.id) FILTER (WHERE b.status = 'occupied')::int as occupied,
        COUNT(b.id) FILTER (WHERE b.status = 'available')::int as available,
        COUNT(b.id) FILTER (WHERE b.status = 'reserved')::int as reserved,
        COUNT(b.id) FILTER (WHERE b.status = 'maintenance')::int as maintenance
      FROM wards w
      LEFT JOIN beds b ON b.ward_id = w.id
      GROUP BY w.id, w.name, w.floor, w.total_beds
      ORDER BY w.name
    `);
  }

  async createBed(data) {
    const { ward_id, bed_number, status, notes } = data;
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, bed_number, status, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING ${BED_RETURNING}`,
      parseInt(ward_id), bed_number, status || 'available', notes || null
    );
    return rows[0];
  }

  async updateBed(id, data) {
    const { ward_id, bed_number, status, patient_id, patient_name, notes } = data;
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE beds SET
         ward_id = COALESCE($1, ward_id),
         bed_number = COALESCE($2, bed_number),
         status = COALESCE($3, status),
         patient_id = $4,
         patient_name = $5,
         notes = COALESCE($6, notes),
         updated_at = NOW()
       WHERE id = $7
       RETURNING ${BED_RETURNING}`,
      ward_id ?? null, bed_number ?? null, status ?? null,
      patient_id ?? null, patient_name ?? null, notes ?? null, parseInt(id)
    );
    return rows[0];
  }

  async deleteBed(id) {
    const count = await prisma.$executeRawUnsafe(
      `DELETE FROM beds WHERE id = $1`, parseInt(id));
    return count > 0;
  }

  // Dedicated notes-update path. The full PUT /beds/:id handler nulls
  // patient_id/patient_name when those fields aren't echoed back in the
  // body — fine for admin tooling that always sends the whole row, but
  // not for the staff app's bed-detail sheet which sends only `{ notes }`.
  // Keeping this isolated guarantees a notes save can't silently
  // discharge the patient. Returns the updated bed (with the same join
  // shape getBedsByWard uses) or null when the id doesn't exist.
  async updateBedNotes(id, notes) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE beds
         SET notes = $1,
             updated_at = NOW()
       WHERE id = $2
       RETURNING ${BED_RETURNING}`,
      typeof notes === 'string' ? notes : null, parseInt(id)
    );
    return rows[0] ?? null;
  }

  async admitPatient(bedId, { patient_id, patient_name, notes }) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE beds SET
         status = 'occupied',
         patient_id = $1,
         patient_name = $2,
         admitted_at = NOW(),
         assigned_at = NOW(),
         notes = COALESCE($3, notes),
         updated_at = NOW()
       WHERE id = $4 AND status = 'available'
       RETURNING ${BED_RETURNING}`,
      patient_id ?? null, patient_name, notes ?? null, parseInt(bedId)
    );
    return rows[0];
  }

  async dischargePatient(bedId) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE beds SET
         status = 'available',
         patient_id = NULL,
         patient_name = NULL,
         admitted_at = NULL,
         updated_at = NOW()
       WHERE id = $1 AND status = 'occupied'
       RETURNING ${BED_RETURNING}`,
      parseInt(bedId)
    );
    return rows[0];
  }
}

export default new BedService();
