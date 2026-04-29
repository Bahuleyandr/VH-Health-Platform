import logger from './logging/logger.js';
import cluster from 'node:cluster';
import os from 'node:os';

const AVAILABLE_WORKERS = Math.max(1, typeof os.availableParallelism === 'function'
  ? os.availableParallelism()
  : os.cpus().length);

function resolveWorkerCount(value) {
  if (!value) return 1;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, AVAILABLE_WORKERS);
}

const WORKERS = resolveWorkerCount(process.env.CLUSTER_WORKERS);

if (cluster.isPrimary) {
  logger.info(`Primary ${process.pid} starting ${WORKERS} worker(s). Set CLUSTER_WORKERS to override.`);

  for (let i = 0; i < WORKERS; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    logger.info(`Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    setTimeout(() => cluster.fork(), 1000); // 1s backoff before restart
  });

  process.on('SIGTERM', () => {
    logger.info('Primary received SIGTERM. Shutting down workers...');
    for (const id in cluster.workers) {
      cluster.workers[id].kill('SIGTERM');
    }
  });
} else {
  // Worker process — load the actual server
  import('./bin/www.js');
}
