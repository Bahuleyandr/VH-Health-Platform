// src/db.js

import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

// Determine if SSL should be used based on the connection target
const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false }
});

// ✅ Log the active database connection
console.log(`✅ Connected to database: ${connectionString}`);

// ✅ Export as default for ESM compatibility
export default pool;
