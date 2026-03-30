// src/lib/prisma.js — Singleton Prisma Client
//
// Provides a shared PrismaClient instance with connection pooling.
// Uses the same DATABASE_URL as the existing pg pool.
//
// Usage:
//   import prisma from '../lib/prisma.js';
//   const user = await prisma.users.findUnique({ where: { phone } });

import { PrismaClient } from '@prisma/client';
import logger from '../logging/logger.js';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
    ...(process.env.NODE_ENV === 'development'
      ? [{ level: 'query', emit: 'event' }]
      : []),
  ],
});

prisma.$on('warn', (e) => {
  logger.warn('Prisma warning:', e.message);
});

prisma.$on('error', (e) => {
  logger.error('Prisma error:', e.message);
});

if (process.env.NODE_ENV === 'development') {
  prisma.$on('query', (e) => {
    if (e.duration > 1000) {
      logger.warn('Slow Prisma query', {
        duration_ms: e.duration,
        query: e.query.substring(0, 200),
      });
    }
  });
}

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

export default prisma;
