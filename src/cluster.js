import logger from './logging/logger.js';
import cluster from 'node:cluster';
import os from 'node:os';

const WORKERS = parseInt(process.env.CLUSTER_WORKERS || os.cpus().length, 10);

if (cluster.isPrimary) {
  logger.info(`Primary ${process.pid} starting ${WORKERS} workers...`);

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
