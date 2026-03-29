import cluster from 'node:cluster';
import os from 'node:os';

const WORKERS = parseInt(process.env.CLUSTER_WORKERS || os.cpus().length, 10);

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} starting ${WORKERS} workers...`);

  for (let i = 0; i < WORKERS; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    setTimeout(() => cluster.fork(), 1000); // 1s backoff before restart
  });

  process.on('SIGTERM', () => {
    console.log('Primary received SIGTERM. Shutting down workers...');
    for (const id in cluster.workers) {
      cluster.workers[id].kill('SIGTERM');
    }
  });
} else {
  // Worker process — load the actual server
  import('./bin/www.js');
}
