// src/config/database.js - SAFE DATABASE CONNECTION
import pkg from 'pg';
const { Pool } = pkg;
import logger from '../logging/logger.js';

let consecutiveFailures = 0;
let circuitOpen = false;
let circuitOpenedAt = null;
const CIRCUIT_BREAKER_THRESHOLD = 5; // Open after 5 consecutive failures
const CIRCUIT_BREAKER_RESET_MS = 30000; // Try again after 30 seconds

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
          statement_timeout: 30000,
        });

        this.pool.on('error', (err) => {
          logger.error('Unexpected database pool error:', err);
        });

        this.pool.on('connect', () => {
          logger.debug('New database connection established');
        });

        // Test connection
        const client = await this.pool.connect();
        await client.query('SELECT NOW()');
        client.release();
        
        // Read replica support — falls back to primary if no replica configured
        if (process.env.DATABASE_READ_URL) {
          this.readPool = new Pool({
            connectionString: process.env.DATABASE_READ_URL,
            ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
            max: parseInt(process.env.DB_READ_POOL_MAX || '10'),
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
            statement_timeout: 30000,
          });
          logger.info('Read replica pool configured');
        } else {
          this.readPool = this.pool; // Fallback to primary
        }

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
    // Circuit breaker: if open, reject immediately
    if (circuitOpen) {
      const elapsed = Date.now() - circuitOpenedAt;
      if (elapsed < CIRCUIT_BREAKER_RESET_MS) {
        throw new Error('Database circuit breaker is open — service temporarily unavailable');
      }
      // Half-open: allow one request through to test
      circuitOpen = false;
      logger.info('Database circuit breaker half-open — testing connection');
    }

    if (!this.isConnected) {
      const connected = await this.connect();
      if (!connected) {
        throw new Error('Database not available - running in debug mode');
      }
    }

    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      consecutiveFailures = 0; // Reset on success
      if (duration > 1000) {
        logger.warn('Slow query detected', {
          duration_ms: duration,
          query: text.substring(0, 200),
          rowCount: result.rowCount
        });
      }
      return result;
    } catch (error) {
      consecutiveFailures++;
      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitOpen = true;
        circuitOpenedAt = Date.now();
        logger.error(`Database circuit breaker OPEN after ${consecutiveFailures} consecutive failures`);
      }
      const duration = Date.now() - start;
      logger.error('Database query error', {
        duration_ms: duration,
        error: error.message,
        query: text.substring(0, 100)
      });
      throw error;
    }
  }

  /**
   * Execute a read-only query against the read replica (or primary if no replica configured).
   * Use for analytics, exports, dashboards — anything that doesn't need write consistency.
   */
  async readQuery(text, params) {
    const start = Date.now();
    try {
      const result = await this.readPool.query(text, params);
      const duration = Date.now() - start;
      if (duration > 1000) {
        logger.warn('Slow read query detected', {
          duration_ms: duration,
          query: text.substring(0, 200),
          rowCount: result.rowCount
        });
      }
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      logger.error('Read query error', {
        duration_ms: duration,
        error: error.message,
        query: text.substring(0, 100)
      });
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

  async healthCheck() {
    try {
      const result = await this.query('SELECT 1 as ok');
      const health = {
        healthy: true,
        writePool: { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount },
      };
      if (this.readPool !== this.pool) {
        health.readPool = { total: this.readPool.totalCount, idle: this.readPool.idleCount, waiting: this.readPool.waitingCount };
      }
      return health;
    } catch (err) {
      return { healthy: false, error: err.message };
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      // Close read pool if it's a separate pool
      if (this.readPool && this.readPool !== this.pool) {
        await this.readPool.end();
      }
      this.isConnected = false;
      logger.info('Database pools closed');
    }
  }
}

// Export singleton instance
let instance = new DatabaseManager();

// For testing: allows replacing the DB instance with a mock
export function setDatabaseInstance(mockDb) {
  instance = mockDb;
}

export function getDatabaseInstance() {
  return instance;
}

export default instance;