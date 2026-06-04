// src/scripts/test-prisma-render.js

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for Prisma Render test');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

async function main() {
  console.log('🔍 Fetching users from Render (Production) database...');

  const users = await prisma.users.findMany();

  if (users.length === 0) {
    console.log('⚠️  No users found in the Render database.');
  } else {
    console.log(`✅ Found ${users.length} user(s) in Render:`, users);
  }
}

main()
  .catch(error => {
    console.error('❌ Error during Prisma Render test:', error);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
