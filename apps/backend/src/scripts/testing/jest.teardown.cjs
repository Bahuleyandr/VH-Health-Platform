/* global afterAll */

afterAll(async () => {
  const cleanupTasks = await Promise.allSettled([
    import('../../lib/prisma.js'),
    import('../../config/database.js'),
    import('../../lib/redis.js'),
  ]);

  const prisma = cleanupTasks[0].status === 'fulfilled' ? cleanupTasks[0].value.default : null;
  const db = cleanupTasks[1].status === 'fulfilled' ? cleanupTasks[1].value.default : null;
  const redis = cleanupTasks[2].status === 'fulfilled' ? cleanupTasks[2].value : null;

  await Promise.allSettled([
    prisma?.$disconnect?.(),
    db?.close?.(),
    redis?.disconnectRedis?.(),
  ]);
});
