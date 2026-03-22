// src/config/database.js - SAFE DATABASE CONNECTION
import pkg from 'pg';
const { Pool } = pkg;
import logger from '../logging/logger.js';

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
          ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 2000,
        });

        // Test connection
        const client = await this.pool.connect();
        await client.query('SELECT NOW()');
        client.release();
        
        this.isConnected = true;
        logger.info('✅ Database connected successfully');
        return true;
      }
      
      if (!process.env.DATABASE_URL) {
        logger.warn('⚠️ DATABASE_URL not found - running in debug mode');
        return false;
      }
      
      return this.isConnected;
    } catch (error) {
      logger.error('❌ Database connection failed:', error.message);
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
      logger.error('❌ Database query failed:', error.message);
      throw error;
    }
  }

  async getClient() {
    if (!this.isConnected) {
      const connected = await this.connect();
      if (!connected) {
        throw new Error('Database not available - running in debug mode');
      }
    }

    try {
      const client = await this.pool.connect();
      return client;
    } catch (error) {
      logger.error('❌ Failed to get database client:', error.message);
      throw error;
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
      logger.info('✅ Database connection closed');
    }
  }
}

// Export singleton instance
const db = new DatabaseManager();
export default db;