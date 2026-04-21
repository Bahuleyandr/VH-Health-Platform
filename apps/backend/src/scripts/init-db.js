// src/scripts/init-db.js
// Idempotent database initialization script for VHHealth
// Run: node --env-file=.env src/scripts/init-db.js

import bcrypt from 'bcrypt';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const adminUsername = process.env.ADMIN_BOOTSTRAP_USERNAME || 'admin';
const adminEmail = process.env.ADMIN_BOOTSTRAP_EMAIL || 'admin@vhhealth.com';
const adminName = process.env.ADMIN_BOOTSTRAP_NAME || 'Super Admin';
const adminPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;

async function run(client, sql, label) {
  try {
    await client.query(sql);
    console.log(`  ✅ ${label}`);
  } catch (err) {
    console.error(`  ❌ ${label}: ${err.message}`);
    throw err;
  }
}

async function initDB() {
  const client = await pool.connect();
  console.log('\n🚀 VHHealth Database Initialization\n');

  try {
    await client.query('BEGIN');

    // ─── Extensions ────────────────────────────────────────────────────────────
    console.log('📦 Extensions...');
    await run(client, `CREATE EXTENSION IF NOT EXISTS pgcrypto`, 'pgcrypto extension');

    // ─── Users ─────────────────────────────────────────────────────────────────
    console.log('\n👥 Users table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS users (
        id           SERIAL PRIMARY KEY,
        uid          UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
        phone        VARCHAR(20) UNIQUE NOT NULL,
        name         VARCHAR(255),
        email        VARCHAR(255),
        gender       VARCHAR(20),
        birthday     DATE,
        anniversary  DATE,
        address      TEXT,
        emergency_contact  TEXT,
        profile_picture    VARCHAR(500),
        role         VARCHAR(50) DEFAULT 'PATIENT',
        device_token VARCHAR(255),
        blood_group  VARCHAR(10),
        allergies    TEXT,
        insurance_details  TEXT,
        preferred_hospital TEXT,
        is_active    BOOLEAN DEFAULT true,
        registered_at TIMESTAMP DEFAULT NOW(),
        last_login   TIMESTAMP,
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      )
    `, 'users table');

    // Add device_token column if it was missing (for existing tables)
    await run(client, `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS device_token VARCHAR(255)
    `, 'users.device_token column');

    // Add other potentially missing columns
    await run(client, `ALTER TABLE users ADD COLUMN IF NOT EXISTS blood_group VARCHAR(10)`, 'users.blood_group column');
    await run(client, `ALTER TABLE users ADD COLUMN IF NOT EXISTS allergies TEXT`, 'users.allergies column');
    await run(client, `ALTER TABLE users ADD COLUMN IF NOT EXISTS insurance_details TEXT`, 'users.insurance_details column');
    await run(client, `ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_hospital TEXT`, 'users.preferred_hospital column');
    await run(client, `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`, 'users.is_active column');

    // ─── Admins ────────────────────────────────────────────────────────────────
    console.log('\n🔐 Admins table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS admins (
        uid                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        username           VARCHAR(255) UNIQUE NOT NULL,
        password_hash      VARCHAR(255) NOT NULL,
        email              VARCHAR(255),
        name               VARCHAR(255),
        role               VARCHAR(50) DEFAULT 'ADMIN',
        permissions        TEXT[],
        is_active          BOOLEAN DEFAULT true,
        status             VARCHAR(50) DEFAULT 'active',
        created_at         TIMESTAMP DEFAULT NOW(),
        last_login         TIMESTAMP,
        created_by         UUID,
        deactivated_by     UUID,
        deactivation_reason TEXT,
        deactivated_at     TIMESTAMP,
        reactivated_by     UUID,
        reactivated_at     TIMESTAMP
      )
    `, 'admins table');

    // ─── Departments ───────────────────────────────────────────────────────────
    console.log('\n🏥 Departments table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS departments (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(255) UNIQUE NOT NULL,
        description     TEXT,
        head_doctor_id  INTEGER,
        contact_number  VARCHAR(20),
        location        VARCHAR(255),
        is_active       BOOLEAN DEFAULT true,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      )
    `, 'departments table');

    // ─── Doctors ───────────────────────────────────────────────────────────────
    console.log('\n👨‍⚕️ Doctors table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS doctors (
        id               SERIAL PRIMARY KEY,
        user_id          INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        department_id    INTEGER REFERENCES departments(id),
        specialization   VARCHAR(255),
        department       VARCHAR(255),
        experience_years INTEGER DEFAULT 0,
        consultation_fee NUMERIC(10,2),
        available_days   TEXT[],
        available_hours  JSONB,
        is_available     BOOLEAN DEFAULT true,
        bio              TEXT,
        education        TEXT,
        qualifications   TEXT[],
        certifications   TEXT[],
        created_at       TIMESTAMP DEFAULT NOW(),
        updated_at       TIMESTAMP DEFAULT NOW()
      )
    `, 'doctors table');

    // ─── Staff ─────────────────────────────────────────────────────────────────
    console.log('\n👔 Staff table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS staff (
        uid              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id          INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        employee_id      VARCHAR(50) UNIQUE,
        position         VARCHAR(100),
        department       VARCHAR(255),
        shift            VARCHAR(50),
        salary           NUMERIC(12,2),
        hire_date        DATE,
        supervisor_id    INTEGER,
        emergency_contact TEXT,
        skills           JSONB,
        certifications   JSONB,
        notes            TEXT,
        pin_hash         VARCHAR(255),
        is_active        BOOLEAN DEFAULT true,
        created_at       TIMESTAMP DEFAULT NOW(),
        updated_at       TIMESTAMP DEFAULT NOW(),
        created_by       UUID
      )
    `, 'staff table');

    // ─── Appointments ──────────────────────────────────────────────────────────
    console.log('\n📅 Appointments table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS appointments (
        id               SERIAL PRIMARY KEY,
        uid              UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
        patient_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        doctor_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        appointment_date TIMESTAMP,
        appointment_time VARCHAR(10),
        reason           TEXT,
        notes            TEXT,
        status           VARCHAR(50) DEFAULT 'SCHEDULED',
        phone            VARCHAR(20),
        created_at       TIMESTAMP DEFAULT NOW(),
        updated_at       TIMESTAMP DEFAULT NOW(),
        created_by       INTEGER
      )
    `, 'appointments table');

    // Add missing columns if table existed without them
    await run(client, `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS uid UUID DEFAULT gen_random_uuid()`, 'appointments.uid column');
    await run(client, `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`, 'appointments.phone column');

    // ─── Notifications ─────────────────────────────────────────────────────────
    console.log('\n🔔 Notifications table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS notifications (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        phone        VARCHAR(20),
        title        VARCHAR(500),
        body         TEXT,
        message      TEXT,
        type         VARCHAR(100),
        priority     VARCHAR(50) DEFAULT 'NORMAL',
        is_read      BOOLEAN DEFAULT false,
        read         BOOLEAN DEFAULT false,
        data         JSONB,
        sender_id    UUID,
        scheduled_for TIMESTAMP,
        created_by   UUID,
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      )
    `, 'notifications table');

    // ─── Devices ───────────────────────────────────────────────────────────────
    console.log('\n📱 Devices table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS devices (
        id           SERIAL PRIMARY KEY,
        phone        VARCHAR(20) UNIQUE NOT NULL,
        fcm_token    VARCHAR(500),
        platform     VARCHAR(50) DEFAULT 'unknown',
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      )
    `, 'devices table');

    // ─── OTP Sessions ──────────────────────────────────────────────────────────
    console.log('\n🔢 OTP tables...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS otp_sessions (
        id         SERIAL PRIMARY KEY,
        phone      VARCHAR(20) NOT NULL,
        otp        VARCHAR(10) NOT NULL,
        purpose    VARCHAR(50) DEFAULT 'general',
        user_id    UUID,
        expires_at TIMESTAMP NOT NULL,
        attempts   INTEGER DEFAULT 0,
        verified   BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'otp_sessions table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS otp_codes (
        id         SERIAL PRIMARY KEY,
        phone      VARCHAR(20) NOT NULL,
        code       VARCHAR(10) NOT NULL,
        purpose    VARCHAR(50) DEFAULT 'login',
        expires_at TIMESTAMP NOT NULL,
        used       BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'otp_codes table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS otp_logs (
        id         SERIAL PRIMARY KEY,
        phone      VARCHAR(20),
        purpose    VARCHAR(50),
        action     VARCHAR(50),
        success    BOOLEAN,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'otp_logs table');

    // ─── Password Reset OTPs ───────────────────────────────────────────────────
    await run(client, `
      CREATE TABLE IF NOT EXISTS password_reset_otps (
        id         SERIAL PRIMARY KEY,
        user_id    UUID NOT NULL,
        otp        VARCHAR(10) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used       BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'password_reset_otps table');

    // ─── Auth Logs ─────────────────────────────────────────────────────────────
    console.log('\n📋 Log tables...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS auth_logs (
        id         SERIAL PRIMARY KEY,
        user_id    UUID,
        phone      VARCHAR(20),
        action     VARCHAR(100),
        success    BOOLEAN DEFAULT true,
        ip_address VARCHAR(50),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'auth_logs table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS audit_logs (
        id         SERIAL PRIMARY KEY,
        uid        UUID,
        role       VARCHAR(50),
        ip         VARCHAR(50),
        action     VARCHAR(255) NOT NULL,
        platform   VARCHAR(50),
        phone      VARCHAR(20),
        metadata   JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'audit_logs table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS admin_activity_logs (
        id               SERIAL PRIMARY KEY,
        admin_uid        UUID,
        action           VARCHAR(255),
        description      TEXT,
        affected_user_id INTEGER,
        details          JSONB,
        ip_address       VARCHAR(50),
        created_at       TIMESTAMP DEFAULT NOW()
      )
    `, 'admin_activity_logs table');

    // ─── Investigations ────────────────────────────────────────────────────────
    console.log('\n🔬 Investigations table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS investigations (
        id              SERIAL PRIMARY KEY,
        patient_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        doctor_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        phone           VARCHAR(20),
        test_name       VARCHAR(500) NOT NULL,
        test_code       VARCHAR(100),
        type            VARCHAR(100) DEFAULT 'GENERAL',
        priority        VARCHAR(50) DEFAULT 'NORMAL',
        status          VARCHAR(50) DEFAULT 'PENDING',
        results         TEXT,
        normal_range    VARCHAR(255),
        unit            VARCHAR(50),
        notes           TEXT,
        cost            NUMERIC(10,2),
        ordered_date    TIMESTAMP DEFAULT NOW(),
        scheduled_date  TIMESTAMP,
        completed_date  TIMESTAMP,
        file_key        VARCHAR(500),
        created_by      UUID,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      )
    `, 'investigations table');

    // ─── Investigation Files ───────────────────────────────────────────────────
    await run(client, `
      CREATE TABLE IF NOT EXISTS investigation_files (
        id               SERIAL PRIMARY KEY,
        investigation_id INTEGER REFERENCES investigations(id) ON DELETE CASCADE,
        file_name        VARCHAR(500),
        file_key         VARCHAR(500),
        file_url         VARCHAR(1000),
        file_type        VARCHAR(100),
        uploaded_at      TIMESTAMP DEFAULT NOW()
      )
    `, 'investigation_files table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS investigation_templates (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) UNIQUE NOT NULL,
        description TEXT,
        type        VARCHAR(100),
        tests       JSONB,
        created_by  UUID,
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `, 'investigation_templates table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS investigation_template_tests (
        id          SERIAL PRIMARY KEY,
        template_id INTEGER REFERENCES investigation_templates(id) ON DELETE CASCADE,
        test_name   VARCHAR(500),
        test_code   VARCHAR(100),
        normal_range VARCHAR(255),
        unit        VARCHAR(50)
      )
    `, 'investigation_template_tests table');

    // ─── Pharmacy Orders ───────────────────────────────────────────────────────
    console.log('\n💊 Pharmacy table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS pharmacy_orders (
        id          SERIAL PRIMARY KEY,
        phone       VARCHAR(20) NOT NULL,
        patient_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        order_note  TEXT,
        file_key    VARCHAR(500),
        status      VARCHAR(50) DEFAULT 'pending',
        total_cost  NUMERIC(10,2),
        notes       TEXT,
        created_by  UUID,
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW()
      )
    `, 'pharmacy_orders table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS medications (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        description TEXT,
        unit        VARCHAR(50),
        price       NUMERIC(10,2),
        stock       INTEGER DEFAULT 0,
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `, 'medications table');

    // ─── Health Records ────────────────────────────────────────────────────────
    console.log('\n🏥 Health records table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS health_records (
        id            SERIAL PRIMARY KEY,
        patient_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        recorded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        record_type   VARCHAR(100) NOT NULL,
        vital_signs   JSONB,
        measurements  JSONB,
        symptoms      TEXT,
        notes         TEXT,
        recorded_date TIMESTAMP DEFAULT NOW(),
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      )
    `, 'health_records table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS medical_records (
        id            SERIAL PRIMARY KEY,
        patient_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        doctor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        diagnosis     TEXT,
        treatment     TEXT,
        prescription  TEXT,
        visit_date    TIMESTAMP DEFAULT NOW(),
        notes         TEXT,
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `, 'medical_records table');

    // ─── File Metadata ─────────────────────────────────────────────────────────
    console.log('\n📁 File metadata table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS file_metadata (
        id                  SERIAL PRIMARY KEY,
        file_name           VARCHAR(500),
        file_type           VARCHAR(100),
        file_size           BIGINT,
        original_size       BIGINT,
        storage_key         VARCHAR(500) UNIQUE NOT NULL,
        storage_url         TEXT,
        category            VARCHAR(100),
        description         TEXT,
        is_private          BOOLEAN DEFAULT false,
        is_hipaa_protected  BOOLEAN DEFAULT false,
        uploaded_by         UUID,
        uploaded_by_role    VARCHAR(50),
        patient_phone       VARCHAR(20),
        related_id          VARCHAR(100),
        related_type        VARCHAR(100),
        compression_applied BOOLEAN DEFAULT false,
        processing_time_ms  INTEGER,
        scan_status         VARCHAR(50) DEFAULT 'pending',
        retention_date      TIMESTAMP,
        urgency_level       VARCHAR(50),
        upload_ip           VARCHAR(50),
        upload_user_agent   TEXT,
        uploaded_at         TIMESTAMP DEFAULT NOW(),
        deleted_at          TIMESTAMP
      )
    `, 'file_metadata table');

    // ─── File Access / Deletion Logs ───────────────────────────────────────────
    await run(client, `
      CREATE TABLE IF NOT EXISTS file_access_logs (
        id          SERIAL PRIMARY KEY,
        file_id     INTEGER REFERENCES file_metadata(id) ON DELETE SET NULL,
        user_id     UUID,
        access_type VARCHAR(50),
        ip_address  VARCHAR(50),
        user_agent  TEXT,
        notes       TEXT,
        accessed_at TIMESTAMP DEFAULT NOW()
      )
    `, 'file_access_logs table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS file_deletion_log (
        id                SERIAL PRIMARY KEY,
        file_id           INTEGER,
        file_name         VARCHAR(500),
        storage_key       VARCHAR(500),
        category          VARCHAR(100),
        file_size         BIGINT,
        is_hipaa_protected BOOLEAN,
        uploaded_by       UUID,
        deleted_by        UUID,
        deletion_reason   TEXT,
        deletion_type     VARCHAR(50),
        ip_address        VARCHAR(50),
        deleted_at        TIMESTAMP DEFAULT NOW()
      )
    `, 'file_deletion_log table');

    // ─── Feedback ──────────────────────────────────────────────────────────────
    console.log('\n💬 Feedback table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS feedback (
        id         SERIAL PRIMARY KEY,
        phone      VARCHAR(20),
        rating     INTEGER CHECK (rating >= 1 AND rating <= 5),
        comment    TEXT,
        question   TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'feedback table');

    await run(client, `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS question TEXT`, 'feedback.question column');

    await run(client, `
      CREATE TABLE IF NOT EXISTS feedback_responses (
        id          SERIAL PRIMARY KEY,
        feedback_id INTEGER REFERENCES feedback(id) ON DELETE CASCADE,
        responder   UUID,
        response    TEXT,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `, 'feedback_responses table');

    // ─── SOS Alerts ────────────────────────────────────────────────────────────
    console.log('\n🚨 SOS alerts table...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS sos_alerts (
        id                SERIAL PRIMARY KEY,
        phone             VARCHAR(20) NOT NULL,
        user_uid          UUID,
        latitude          DOUBLE PRECISION,
        longitude         DOUBLE PRECISION,
        severity          VARCHAR(50) DEFAULT 'HIGH',
        message           TEXT,
        emergency_type    VARCHAR(100),
        contact_preference VARCHAR(50) DEFAULT 'hospital',
        ip_address        VARCHAR(50),
        user_agent        TEXT,
        medical_conditions TEXT,
        medications       TEXT,
        emergency_contact TEXT,
        allergies         TEXT,
        blood_group       VARCHAR(10),
        insurance_details TEXT,
        preferred_hospital TEXT,
        status            VARCHAR(50) DEFAULT 'active',
        is_test_alert     BOOLEAN DEFAULT false,
        responded_by      UUID,
        responded_at      TIMESTAMP,
        resolved_at       TIMESTAMP,
        created_by        UUID,
        created_at        TIMESTAMP DEFAULT NOW(),
        updated_at        TIMESTAMP DEFAULT NOW()
      )
    `, 'sos_alerts table');

    // ─── Bulk / Batch Operation Logs ───────────────────────────────────────────
    console.log('\n📊 Operational log tables...');
    await run(client, `
      CREATE TABLE IF NOT EXISTS bulk_operation_logs (
        id                SERIAL PRIMARY KEY,
        operation_type    VARCHAR(100),
        performed_by      UUID,
        affected_count    INTEGER,
        success_count     INTEGER,
        error_count       INTEGER,
        operation_details JSONB,
        performed_at      TIMESTAMP DEFAULT NOW()
      )
    `, 'bulk_operation_logs table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS batch_upload_logs (
        id          SERIAL PRIMARY KEY,
        uploaded_by UUID,
        file_name   VARCHAR(500),
        record_count INTEGER,
        status      VARCHAR(50),
        errors      JSONB,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `, 'batch_upload_logs table');

    // ─── Staff Auth / Device Sessions ──────────────────────────────────────────
    await run(client, `
      CREATE TABLE IF NOT EXISTS staff_auth_sessions (
        id          SERIAL PRIMARY KEY,
        staff_uid   UUID,
        token_hash  VARCHAR(500),
        device_info JSONB,
        expires_at  TIMESTAMP,
        created_at  TIMESTAMP DEFAULT NOW(),
        is_active   BOOLEAN DEFAULT true
      )
    `, 'staff_auth_sessions table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS staff_devices (
        id          SERIAL PRIMARY KEY,
        staff_uid   UUID,
        device_token VARCHAR(500),
        platform    VARCHAR(50),
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW()
      )
    `, 'staff_devices table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS user_devices (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
        device_token VARCHAR(500),
        platform     VARCHAR(50),
        is_active    BOOLEAN DEFAULT true,
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      )
    `, 'user_devices table');

    // ─── Notification Templates ────────────────────────────────────────────────
    await run(client, `
      CREATE TABLE IF NOT EXISTS notification_templates (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) UNIQUE NOT NULL,
        title       VARCHAR(500),
        body        TEXT,
        type        VARCHAR(100),
        variables   JSONB,
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `, 'notification_templates table');

    // ─── System Settings / Alerts ──────────────────────────────────────────────
    await run(client, `
      CREATE TABLE IF NOT EXISTS system_settings (
        id          SERIAL PRIMARY KEY,
        key         VARCHAR(255) UNIQUE NOT NULL,
        value       TEXT,
        description TEXT,
        updated_by  UUID,
        updated_at  TIMESTAMP DEFAULT NOW()
      )
    `, 'system_settings table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS system_alerts (
        id          SERIAL PRIMARY KEY,
        title       VARCHAR(500),
        message     TEXT,
        severity    VARCHAR(50) DEFAULT 'INFO',
        is_active   BOOLEAN DEFAULT true,
        created_by  UUID,
        created_at  TIMESTAMP DEFAULT NOW(),
        expires_at  TIMESTAMP
      )
    `, 'system_alerts table');

    // ─── Doctor Record / Consultation (legacy compat) ──────────────────────────
    await run(client, `
      CREATE TABLE IF NOT EXISTS consultations (
        id          SERIAL PRIMARY KEY,
        phone       VARCHAR(20),
        file_name   VARCHAR(500),
        file_type   VARCHAR(100),
        doctor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        notes       TEXT,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `, 'consultations table');

    // ─── Appointment Archive ───────────────────────────────────────────────────
    await run(client, `
      CREATE TABLE IF NOT EXISTS appointment_archive (
        id            SERIAL PRIMARY KEY,
        original_id   INTEGER,
        patient_id    INTEGER,
        doctor_id     INTEGER,
        appointment_date TIMESTAMP,
        reason        TEXT,
        status        VARCHAR(50),
        archived_at   TIMESTAMP DEFAULT NOW()
      )
    `, 'appointment_archive table');

    // ─── User Status / Role Audit ──────────────────────────────────────────────
    await run(client, `
      CREATE TABLE IF NOT EXISTS user_status_history (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        old_status VARCHAR(50),
        new_status VARCHAR(50),
        reason     TEXT,
        changed_by UUID,
        changed_at TIMESTAMP DEFAULT NOW()
      )
    `, 'user_status_history table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS user_role_audit (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        old_role   VARCHAR(50),
        new_role   VARCHAR(50),
        changed_by UUID,
        changed_at TIMESTAMP DEFAULT NOW()
      )
    `, 'user_role_audit table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS user_deactivation_log (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reason     TEXT,
        deactivated_by UUID,
        deactivated_at TIMESTAMP DEFAULT NOW()
      )
    `, 'user_deactivation_log table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS user_reactivation_log (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reason     TEXT,
        reactivated_by UUID,
        reactivated_at TIMESTAMP DEFAULT NOW()
      )
    `, 'user_reactivation_log table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS user_action_logs (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action     VARCHAR(255),
        details    JSONB,
        ip_address VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'user_action_logs table');

    // ─── Leave / Attendance (Staff) ────────────────────────────────────────────
    await run(client, `
      CREATE TABLE IF NOT EXISTS leave_applications (
        id           SERIAL PRIMARY KEY,
        staff_uid    UUID,
        type         VARCHAR(100),
        from_date    DATE,
        to_date      DATE,
        reason       TEXT,
        status       VARCHAR(50) DEFAULT 'pending',
        approved_by  UUID,
        created_at   TIMESTAMP DEFAULT NOW()
      )
    `, 'leave_applications table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS leave_balance_overrides (
        id        SERIAL PRIMARY KEY,
        staff_uid UUID,
        type      VARCHAR(100),
        balance   INTEGER,
        updated_by UUID,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `, 'leave_balance_overrides table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS attendance_logs (
        id         SERIAL PRIMARY KEY,
        staff_uid  UUID,
        check_in   TIMESTAMP,
        check_out  TIMESTAMP,
        date       DATE DEFAULT CURRENT_DATE,
        notes      TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'attendance_logs table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS staff_attendance (
        id         SERIAL PRIMARY KEY,
        staff_uid  UUID,
        date       DATE NOT NULL,
        status     VARCHAR(50),
        notes      TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'staff_attendance table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS staff_performance_reviews (
        id           SERIAL PRIMARY KEY,
        staff_uid    UUID,
        reviewer_uid UUID,
        rating       INTEGER CHECK (rating >= 1 AND rating <= 5),
        comments     TEXT,
        period       VARCHAR(50),
        created_at   TIMESTAMP DEFAULT NOW()
      )
    `, 'staff_performance_reviews table');

    // ─── Department Audit ──────────────────────────────────────────────────────
    await run(client, `
      CREATE TABLE IF NOT EXISTS department_audit_log (
        id          SERIAL PRIMARY KEY,
        department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
        action      VARCHAR(255),
        changed_by  UUID,
        changes     JSONB,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `, 'department_audit_log table');

    // ─── Activity / HR / Medical / Pharmacy Logs ───────────────────────────────
    await run(client, `
      CREATE TABLE IF NOT EXISTS hr_activity_logs (
        id         SERIAL PRIMARY KEY,
        actor_uid  UUID,
        action     VARCHAR(255),
        target_uid UUID,
        details    JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'hr_activity_logs table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS medical_activity_logs (
        id         SERIAL PRIMARY KEY,
        actor_uid  UUID,
        action     VARCHAR(255),
        patient_id INTEGER,
        details    JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'medical_activity_logs table');

    await run(client, `
      CREATE TABLE IF NOT EXISTS pharmacy_activity_logs (
        id         SERIAL PRIMARY KEY,
        actor_uid  UUID,
        action     VARCHAR(255),
        order_id   INTEGER REFERENCES pharmacy_orders(id) ON DELETE SET NULL,
        details    JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `, 'pharmacy_activity_logs table');

    // ─── Seed Admin User ───────────────────────────────────────────────────────
    console.log('\n🔑 Seeding admin user...');
    if (!adminPassword) {
      console.log('  ⚠️  Skipped admin seed; set ADMIN_BOOTSTRAP_PASSWORD to create or reset the first admin.');
    } else {
      const passwordHash = await bcrypt.hash(adminPassword, 10);

      const existing = await client.query(
        'SELECT username FROM admins WHERE username = $1',
        [adminUsername]
      );

      if (existing.rows.length > 0) {
        await client.query(
          'UPDATE admins SET password_hash = $1, is_active = true, status = $2 WHERE username = $3',
          [passwordHash, 'active', adminUsername]
        );
        console.log('  ✅ Admin password reset from ADMIN_BOOTSTRAP_PASSWORD');
      } else {
        await client.query(`
          INSERT INTO admins (username, password_hash, email, name, role, is_active, status, permissions)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          adminUsername, passwordHash, adminEmail,
          adminName, 'SUPER_ADMIN', true, 'active', ['all']
        ]);
        console.log(`  ✅ Admin user created (${adminUsername})`);
      }
    }

    await client.query('COMMIT');

    console.log('\n✨ Database initialization complete!\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Initialization failed, rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

initDB();
