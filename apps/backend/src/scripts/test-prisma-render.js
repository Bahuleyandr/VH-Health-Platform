// src/scripts/test-prisma-render.js

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
