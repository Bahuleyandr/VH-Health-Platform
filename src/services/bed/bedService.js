// src/services/bed/bedService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';

class BedService {
  // ===== WARD OPERATIONS =====

  async listWards() {
    const { rows } = await db.query(`
      SELECT w.*, d.name as department_name,
        (SELECT COUNT(*) FROM beds b WHERE b.ward_id = w.id) as bed_count,
        (SELECT COUNT(*) FROM beds b WHERE b.ward_id = w.id AND b.status = 'occupied') as occupied_count
      FROM wards w
      LEFT JOIN departments d ON w.department_id = d.id
      ORDER BY w.name
    `);
    return rows;
  }

  async createWard(data) {
    const { name, floor, department_id, total_beds } = data;
    const { rows } = await db.query(
      `INSERT INTO wards (name, floor, department_id, total_beds) VALUES ($1, $2, $3, $4) RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
      [name, floor || 1, department_id || null, total_beds || 0]
    );
    return rows[0];
  }

  async updateWard(id, data) {
    const { name, floor, department_id, total_beds } = data;
    const { rows } = await db.query(
      `UPDATE wards SET name = COALESCE($1, name), floor = COALESCE($2, floor),
       department_id = COALESCE($3, department_id), total_beds = COALESCE($4, total_beds),
       updated_at = NOW() WHERE id = $5 RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
      [name, floor, department_id, total_beds, id]
    );
    return rows[0];
  }

  async deleteWard(id) {
    const { rowCount } = await db.query('DELETE FROM wards WHERE id = $1', [id]);
    return rowCount > 0;
  }

  // ===== BED OPERATIONS =====

  async listBeds() {
    const { rows } = await db.query(`
      SELECT b.*, w.name as ward_name, w.floor as ward_floor
      FROM beds b
      LEFT JOIN wards w ON b.ward_id = w.id
      ORDER BY w.name, b.bed_number
    `);
    return rows;
  }

  async getBedsByWard(wardId) {
    const { rows } = await db.query(`
      SELECT b.*, w.name as ward_name
      FROM beds b
      LEFT JOIN wards w ON b.ward_id = w.id
      WHERE b.ward_id = $1
      ORDER BY b.bed_number
    `, [wardId]);
    return rows;
  }

  async getBedSummary() {
    const { rows } = await db.query(`
      SELECT w.id as ward_id, w.name as ward_name, w.floor, w.total_beds,
        COUNT(b.id) as actual_beds,
        COUNT(b.id) FILTER (WHERE b.status = 'occupied') as occupied,
        COUNT(b.id) FILTER (WHERE b.status = 'available') as available,
        COUNT(b.id) FILTER (WHERE b.status = 'reserved') as reserved,
        COUNT(b.id) FILTER (WHERE b.status = 'maintenance') as maintenance
      FROM wards w
      LEFT JOIN beds b ON b.ward_id = w.id
      GROUP BY w.id, w.name, w.floor, w.total_beds
      ORDER BY w.name
    `);
    return rows;
  }

  async createBed(data) {
    const { ward_id, bed_number, status, notes } = data;
    const { rows } = await db.query(
      `INSERT INTO beds (ward_id, bed_number, status, notes) VALUES ($1, $2, $3, $4) RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
      [ward_id, bed_number, status || 'available', notes || null]
    );
    return rows[0];
  }

  async updateBed(id, data) {
    const { ward_id, bed_number, status, patient_id, patient_name, notes } = data;
    const { rows } = await db.query(
      `UPDATE beds SET
        ward_id = COALESCE($1, ward_id),
        bed_number = COALESCE($2, bed_number),
        status = COALESCE($3, status),
        patient_id = $4,
        patient_name = $5,
        notes = COALESCE($6, notes),
        updated_at = NOW()
      WHERE id = $7 RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
      [ward_id, bed_number, status, patient_id ?? null, patient_name ?? null, notes, id]
    );
    return rows[0];
  }

  async deleteBed(id) {
    const { rowCount } = await db.query('DELETE FROM beds WHERE id = $1', [id]);
    return rowCount > 0;
  }

  async admitPatient(bedId, { patient_id, patient_name, notes }) {
    const { rows } = await db.query(
      `UPDATE beds SET status = 'occupied', patient_id = $1, patient_name = $2,
       admitted_at = NOW(), notes = COALESCE($3, notes), updated_at = NOW()
       WHERE id = $4 AND status = 'available' RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
      [patient_id || null, patient_name, notes || null, bedId]
    );
    return rows[0];
  }

  async dischargePatient(bedId) {
    const { rows } = await db.query(
      `UPDATE beds SET status = 'available', patient_id = NULL, patient_name = NULL,
       admitted_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'occupied' RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
      [bedId]
    );
    return rows[0];
  }
}

export default new BedService();
