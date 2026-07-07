import logger from '../src/logging/logger.js';
import pg from 'pg';
import { randomUUID } from 'crypto';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const DEPARTMENTS = [
  'Cardiology', 'Neurology', 'Orthopaedics', 'General Medicine', 'General Surgery',
  'Obstetrics & Gynaecology', 'Paediatrics', 'Dermatology', 'ENT (Otorhinolaryngology)',
  'Ophthalmology', 'Nephrology', 'Urology', 'Pulmonology', 'Gastroenterology',
  'Oncology', 'Psychiatry', 'Physiotherapy & Rehabilitation', 'Emergency Medicine',
  'Radiology', 'Pathology', 'Dentistry',
];

const DOCTORS = [
  ['9000000001', 'Dr. Thillai Vallal',  'Cardiology',                       'Interventional Cardiology', 25, 1000],
  ['9000000002', 'Dr. Ramesh Kumar',    'Cardiology',                       'Clinical Cardiology',        15,  800],
  ['9000000003', 'Dr. Priya Sharma',    'Neurology',                        'Neurology & Stroke',         18,  900],
  ['9000000004', 'Dr. Arjun Menon',     'Orthopaedics',                     'Joint Replacement Surgery',  20,  800],
  ['9000000005', 'Dr. Lakshmi Iyer',    'General Medicine',                 'Internal Medicine',          22,  500],
  ['9000000006', 'Dr. Suresh Babu',     'General Surgery',                  'Laparoscopic Surgery',       16,  700],
  ['9000000007', 'Dr. Meera Krishnan',  'Obstetrics & Gynaecology',         'High-Risk Pregnancy',        19,  700],
  ['9000000008', 'Dr. Anitha Raj',      'Paediatrics',                      'Paediatrics & Neonatology',  14,  600],
  ['9000000009', 'Dr. Kavitha Nair',    'Dermatology',                      'Dermatology & Cosmetology',  12,  600],
  ['9000000010', 'Dr. Rajesh Pillai',   'ENT (Otorhinolaryngology)',        'ENT Surgery',                17,  600],
  ['9000000011', 'Dr. Saranya Devi',    'Ophthalmology',                    'Retina & Glaucoma',          15,  500],
  ['9000000012', 'Dr. Manoj Varma',     'Nephrology',                       'Dialysis & Transplant',      13,  800],
  ['9000000013', 'Dr. Deepa Raman',     'Gastroenterology',                 'Hepatology',                 16,  800],
  ['9000000014', 'Dr. Vikram Singh',    'Pulmonology',                      'Sleep Medicine',             14,  700],
  ['9000000015', 'Dr. Nandini Rao',     'Oncology',                         'Medical Oncology',           12, 1000],
  ['9000000016', 'Dr. Prakash Reddy',   'Urology',                          'Urology & Andrology',        18,  700],
  ['9000000017', 'Dr. Shyamala Menon',  'Psychiatry',                       'Psychiatry & Counselling',   10,  600],
  ['9000000018', 'Dr. Ganesh Iyer',     'Physiotherapy & Rehabilitation',   'Orthopaedic Rehab',           8,  400],
  ['9000000019', 'Dr. Kavya Hari',      'Emergency Medicine',               'Critical Care',              15,  500],
  ['9000000020', 'Dr. Arun Raghavan',   'General Medicine',                 'General Medicine',           10,  400],
  ['9000000021', 'Dr. Nisha Varghese',  'Dentistry',                        'Conservative Dentistry',     12,  600],
];

await client.query('BEGIN');
try {
  for (const name of DEPARTMENTS) {
    await client.query(
      `INSERT INTO departments (name, updated_at) VALUES ($1, NOW())
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [name]
    );
  }

  for (const [phone, name, dept, specialty] of DOCTORS) {
    const uid = randomUUID();
    const u = await client.query(
      `INSERT INTO users (uid, phone, name, role, is_active, status, updated_at)
       VALUES ($1, $2, $3, 'DOCTOR', true, 'active', NOW())
       ON CONFLICT (tenant_id, phone) DO UPDATE SET
         name = EXCLUDED.name,
         role = 'DOCTOR',
         is_active = true,
         status = 'active',
         updated_at = NOW()
       RETURNING id`,
      [uid, phone, name]
    );
    const userId = u.rows[0].id;
    const d = await client.query(`SELECT id FROM departments WHERE name = $1`, [dept]);
    const deptId = d.rows[0]?.id ?? null;
    const existingDoctor = await client.query(
      'SELECT id FROM doctors WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    if (existingDoctor.rowCount) {
      await client.query(
        `UPDATE doctors
         SET name = $1, department_id = $2, department = $3, specialty = $4, updated_at = NOW()
         WHERE id = $5`,
        [name, deptId, dept, specialty, existingDoctor.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO doctors (user_id, name, department_id, department, specialty, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [userId, name, deptId, dept, specialty]
      );
    }
  }
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  logger.error('FAIL', e.message);
  process.exit(1);
}

const counts = await client.query(
  `SELECT 'departments' AS t, count(*)::int AS n FROM departments
   UNION ALL SELECT 'doctors', count(*)::int FROM doctors
   UNION ALL SELECT 'doctor_users', count(*)::int FROM users WHERE phone LIKE '9000000%'`
);
logger.info(JSON.stringify(counts.rows));
await client.end();
