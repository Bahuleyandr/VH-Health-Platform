import express from 'express';
import {
  performSystemHealthCheck,
  generateSystemDocumentation,
  getSystemStatistics
} from './index.js'; // from your initialized route system

const router = express.Router();

// Health check endpoint
router.get('/health', (req, res) => {
  const health = performSystemHealthCheck();
  res.status(200).json(health);
});

// Documentation (JSON format)
router.get('/docs', (req, res) => {
  try {
    const docs = generateSystemDocumentation('json');
    res.status(200).json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stats
router.get('/stats', (req, res) => {
  const stats = getSystemStatistics();
  res.status(200).json(stats);
});

export default router;
