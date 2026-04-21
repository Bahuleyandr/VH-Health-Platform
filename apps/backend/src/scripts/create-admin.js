// src/scripts/create-admin.js
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env.local') });

const adminUsername = process.env.ADMIN_BOOTSTRAP_USERNAME || 'admin';
const adminEmail = process.env.ADMIN_BOOTSTRAP_EMAIL || 'admin@vhhealth.com';
const adminName = process.env.ADMIN_BOOTSTRAP_NAME || 'Super Admin';
const adminPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;

if (!adminPassword) {
  console.error('ADMIN_BOOTSTRAP_PASSWORD is required. Refusing to create a default admin password.');
  process.exit(1);
}

// Create database connection
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED,
});

async function createTestAdmin() {
  let client;
  try {
    client = await pool.connect();
    
    // First, check if admins table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'admins'
      );
    `);
    
    if (!tableCheck.rows[0].exists) {
      console.log('Creating admins table...');
      await client.query(`
        CREATE TABLE admins (
          uid UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          username VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          email VARCHAR(255),
          name VARCHAR(255),
          role VARCHAR(50) DEFAULT 'ADMIN',
          permissions TEXT[],
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW(),
          last_login TIMESTAMP,
          created_by UUID,
          deactivated_by UUID,
          deactivation_reason TEXT,
          deactivated_at TIMESTAMP,
          reactivated_by UUID,
          reactivated_at TIMESTAMP
        );
      `);
      console.log('✅ Admins table created successfully!');
    }
    
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    
    // Check if admin already exists
    const existing = await client.query(
      'SELECT username FROM admins WHERE username = $1',
      [adminUsername]
    );
    
    if (existing.rows.length > 0) {
      console.log('⚠️  Admin user already exists!');
      
      // Update the password for existing admin
      await client.query(
        'UPDATE admins SET password_hash = $1 WHERE username = $2',
        [passwordHash, adminUsername]
      );
      console.log('✅ Admin password updated from ADMIN_BOOTSTRAP_PASSWORD.');
      return;
    }
    
    // Create admin
    const result = await client.query(`
      INSERT INTO admins (username, password_hash, email, name, role, is_active, permissions)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING uid, username, email, name, role
    `, [
      adminUsername,
      passwordHash, 
      adminEmail,
      adminName,
      'SUPER_ADMIN', 
      true,
      ['all'] // Give all permissions
    ]);
    
    console.log('\n✅ Admin created successfully!');
    console.log('=====================================');
    console.log(`🔑 Username: ${adminUsername}`);
    console.log('🔐 Password: loaded from ADMIN_BOOTSTRAP_PASSWORD');
    console.log(`📧 Email: ${adminEmail}`);
    console.log('=====================================\n');
    console.log('Admin details:', result.rows[0]);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    
    // If it's a connection error, provide helpful message
    if (error.code === 'ECONNREFUSED') {
      console.log('\n⚠️  Database connection failed!');
      console.log('Make sure your DATABASE_URL is set correctly in .env.local');
      console.log('Current DATABASE_URL:', process.env.DATABASE_URL ? '[SET]' : '[NOT SET]');
    }
  } finally {
    if (client) {client.release();}
    await pool.end();
    process.exit();
  }
}

// Run the function
createTestAdmin();
