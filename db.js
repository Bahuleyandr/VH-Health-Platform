// db.js
const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',        // Default PostgreSQL username
  host: 'localhost',       // Since PostgreSQL runs locally
  database: 'vh_health',   // Your database name
  password: 'Neurosurgeon89', // Replace with your password
  port: 5432,              // Default PostgreSQL port
});

module.exports = pool;
