/* global afterAll */

afterAll(async () => {
  const cleanupTasks = await Promise.allSettled([
    import('../../lib/prisma.js'),
    import('../../lib/redis.js'),
  ]);

  const prismaModule = cleanupTasks[0].status === 'fulfilled' ? cleanupTasks[0].value : null;
  const redis = cleanupTasks[1].status === 'fulfilled' ? cleanupTasks[1].value : null;

  const prisma = prismaModule?.default ?? null;
  const prismaReadOnly = prismaModule?.prismaReadOnly ?? null;

  await Promise.allSettled([
    prisma?.$disconnect?.(),
    // If DATABASE_READ_URL wasn't set, prismaReadOnly === prisma and the
    // second call is a safe no-op.
    prismaReadOnly && prismaReadOnly !== prisma ? prismaReadOnly.$disconnect?.() : null,
    redis?.disconnectRedis?.(),
  ]);
});
