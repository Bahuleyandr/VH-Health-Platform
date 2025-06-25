// src/config/database.js - SAFE DATABASE CONNECTION
import pkg from 'pg';
const { Pool } = pkg;

class DatabaseManager {
  constructor() {
    this.pool = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      // Only connect when actually needed, not during import
      if (!this.pool && process.env.DATABASE_URL) {
        this.pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 2000,
        });

        // Test connection
        const client = await this.pool.connect();
        await client.query('SELECT NOW()');
        client.release();
        
        this.isConnected = true;
        console.log('✅ Database connected successfully');
        return true;
      }
      
      if (!process.env.DATABASE_URL) {
        console.log('⚠️ DATABASE_URL not found - running in debug mode');
        return false;
      }
      
      return this.isConnected;
    } catch (error) {
      console.log('❌ Database connection failed:', error.message);
      this.isConnected = false;
      return false;
    }
  }

  async query(text, params) {
    if (!this.isConnected) {
      const connected = await this.connect();
      if (!connected) {
        throw new Error('Database not available - running in debug mode');
      }
    }

    try {
      // ✅ Fixed: Use this.pool.query() here (this is correct within the class)
      const result = await this.pool.query(text, params);
      return result;
    } catch (error) {
      console.log('❌ Database query failed:', error.message);
      throw error;
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
      console.log('✅ Database connection closed');
    }
  }
}

// Export singleton instance
const db = new DatabaseManager();
export default db;