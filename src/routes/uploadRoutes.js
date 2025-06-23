// src/routes/uploadRoutes.js - CLEAN VERSION
import express from 'express';

const router = express.Router();
console.log('✅ uploadRoutes loaded');

router.get('/test', (req, res) => {
  res.json({ message: 'Upload routes working!' });
});

router.post('/file', (req, res) => {
  res.json({ 
    message: 'File upload - Cloud storage disabled for debugging',
    filename: 'sample-file.jpg'
  });
});

router.post('/image', (req, res) => {
  res.json({ 
    message: 'Image upload - Cloud storage disabled for debugging',
    url: 'https://example.com/image.jpg'
  });
});

router.delete('/:fileId', (req, res) => {
  res.json({ 
    message: 'Delete file - Cloud storage disabled for debugging',
    fileId: req.params.fileId
  });
});

export default router;