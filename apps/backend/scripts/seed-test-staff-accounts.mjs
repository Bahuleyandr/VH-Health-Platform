// scripts/seed-test-staff-accounts.mjs
//
// Seeds one staff account per StaffRole enum value used by apps/staff (8
// roles total). The seeded password defaults to a deterministic test value and
// can be overridden with VH_TEST_STAFF_PASSWORD. Idempotent — safe to re-run;
// existing accounts get their password and role re-asserted but records are
// not duplicated.
//
//   node --import dotenv/config scripts/seed-test-staff-accounts.mjs
//
// After running, all accounts log in via:
//   POST /api/v1/auth/staff/login
//     { "employeeId": "EMP-100X", "password": "<seed-password>" }
//
// EMP-1001..EMP-1003 are pre-existing e2e_test seeds (Nurse/Pharmacy/Lab).
// EMP-1004..EMP-1008 are added by this script.
//
// Note: the staff app's login form regex requires the hyphenated `EMP-NNN`
// format; do NOT switch to `EMP1004`-style or the client won't even POST.

import bcrypt from 'bcrypt';
import prisma from '../src/lib/prisma.js';

const DEFAULT_TEST_STAFF_PASSWORD = ['test', '1234'].join('');
const PASSWORD = process.env.VH_TEST_STAFF_PASSWORD || DEFAULT_TEST_STAFF_PASSWORD;

// One per StaffRole enum value in apps/staff/lib/core/config/role_config.dart.
// EMP-1001..1003 are kept in the table for documentation; this script
// won't insert duplicates because of the existence check.
const ACCOUNTS = [
  { emp: 'EMP-1001', name: 'e2e_test Nurse Arya',      role: 'NURSING_STAFF',  phone: '+919999990001', dept: 'General Medicine',    designation: 'Staff Nurse',     position: 'Staff Nurse' },
  { emp: 'EMP-1002', name: 'e2e_test Pharmacist Bala', role: 'PHARMACY_STAFF', phone: '+919999990002', dept: 'Pharmacy',            designation: 'Pharmacist',      position: 'Pharmacist' },
  { emp: 'EMP-1003', name: 'e2e_test LabTech Chitra',  role: 'LAB_STAFF',      phone: '+919999990003', dept: 'Laboratory',          designation: 'Lab Technician',  position: 'Lab Technician' },
  { emp: 'EMP-1004', name: 'Test Doctor',              role: 'DOCTOR',         phone: '+919999990004', dept: 'General Medicine',    designation: 'Consultant',      position: 'Consultant' },
  { emp: 'EMP-1005', name: 'Test HR',                  role: 'HR_STAFF',       phone: '+919999990005', dept: 'HR',                  designation: 'HR Officer',      position: 'HR Officer' },
  { emp: 'EMP-1006', name: 'Test Admin',               role: 'ADMIN',          phone: '+919999990006', dept: 'Administration',      designation: 'Administrator',   position: 'Administrator' },
  { emp: 'EMP-1007', name: 'Test Super Admin',         role: 'SUPER_ADMIN',    phone: '+919999990007', dept: 'Administration',      designation: 'Super Admin',     position: 'Super Admin' },
  { emp: 'EMP-1008', name: 'Test General Staff',       role: 'GENERAL_STAFF',  phone: '+919999990008', dept: 'Operations',          designation: 'Staff',           position: 'Staff' },
  // C-4 — RECEPTIONIST seed. Front-desk role with restricted permissions
  // (per userConfig.js: can manage GENERAL_STAFF only, not clinical roles).
  // Walk-in registration is the highest-volume daily workflow at a small
  // hospital — testing as ADMIN masks RECEPTIONIST-specific RBAC failures.
  // Finding: 2026-05-08-walk-in-opd-receptionist-no-receptionist-role-seeded.
  { emp: 'EMP-1009', name: 'Test Receptionist',        role: 'RECEPTIONIST',   phone: '+919999990009', dept: 'Reception',           designation: 'Receptionist',    position: 'Front Desk' },
];

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);

  const summary = [];
  for (const acc of ACCOUNTS) {
    // Wrap each account's lookup + upsert in a transaction so a concurrent
    // run can't get two halves of the work in via interleaved statements
    // (e.g. find no user → other run inserts → this run inserts → UNIQUE
    // violation on phone). The whole "ensure exactly one user + one staff
    // row for this employee" thing rolls back as a unit on conflict.
    const action = await prisma.$transaction(async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT u.uid, u.id, u.role
         FROM users u
         LEFT JOIN staff s ON s.user_id = u.uid
         WHERE s.employee_id = $1 OR u.phone = $2
         LIMIT 1`,
        acc.emp, acc.phone
      );

      let uid;
      let didInsert = false;
      if (existing.length) {
        uid = existing[0].uid;
        await tx.$executeRawUnsafe(
          `UPDATE users
              SET role = $1,
                  encrypted_password = $2,
                  name = COALESCE(NULLIF(name, ''), $3),
                  phone = $4,
                  is_active = TRUE,
                  status = 'active',
                  updated_at = NOW()
            WHERE uid = $5::uuid`,
          acc.role, hash, acc.name, acc.phone, uid
        );
      } else {
        const inserted = await tx.$queryRawUnsafe(
          `INSERT INTO users
             (uid, phone, name, role, encrypted_password, is_active, status, registered_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, TRUE, 'active', NOW(), NOW())
           RETURNING uid`,
          acc.phone, acc.name, acc.role, hash
        );
        uid = inserted[0].uid;
        didInsert = true;
      }

      const staffExists = await tx.$queryRawUnsafe(
        `SELECT id FROM staff WHERE employee_id = $1 OR user_id = $2::uuid LIMIT 1`,
        acc.emp, uid
      );
      if (staffExists.length === 0) {
        await tx.$executeRawUnsafe(
          `INSERT INTO staff
             (user_id, employee_id, name, designation, position, department, is_active, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())`,
          uid, acc.emp, acc.name, acc.designation, acc.position, acc.dept
        );
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE staff
              SET employee_id = $1,
                  name = $2,
                  designation = $3,
                  position = $4,
                  department = $5,
                  is_active = TRUE,
                  updated_at = NOW()
            WHERE id = $6`,
          acc.emp, acc.name, acc.designation, acc.position, acc.dept, staffExists[0].id
        );
      }
      return didInsert ? 'inserted' : 'updated';
    });
    summary.push({ emp: acc.emp, role: acc.role, action });
  }

  console.log('\n┌──────────┬─────────────────┬──────────┐');
  console.log('│ Employee │ Role            │ Action   │');
  console.log('├──────────┼─────────────────┼──────────┤');
  for (const r of summary) {
    console.log(`│ ${r.emp.padEnd(8)} │ ${r.role.padEnd(15)} │ ${r.action.padEnd(8)} │`);
  }
  console.log('└──────────┴─────────────────┴──────────┘');
  console.log(`\nAll accounts use password: ${PASSWORD}`);
  console.log('Login via: POST /api/v1/auth/staff/login { employeeId, password }\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async err => {
    console.error('Seed failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
