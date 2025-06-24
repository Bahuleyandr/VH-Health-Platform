// src/routes/notificationRoutes.js - PRODUCTION VERSION
import express from 'express';
import db from '../config/database.js';

const router = express.Router();
console.log('✅ notificationRoutes loaded');

// Test route
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Notification routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Get all notifications with filtering and pagination
router.get('/list', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const user_id = req.query.user_id; // Filter by recipient
    const type = req.query.type; // APPOINTMENT, MEDICATION, EMERGENCY, SYSTEM, etc.
    const read_status = req.query.read; // 'true', 'false', or undefined for all
    const priority = req.query.priority; // HIGH, MEDIUM, LOW
    
    let query = `
      SELECT n.id, n.title, n.message, n.type, n.priority, n.is_read,
             n.created_at, n.read_at, n.scheduled_for, n.data,
             u.name as recipient_name, u.phone as recipient_phone,
             sender.name as sender_name
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      LEFT JOIN users sender ON n.sender_id = sender.id
      WHERE 1=1
    `;
    let params = [];
    
    if (user_id) {
      query += ' AND n.user_id = $' + (params.length + 1);
      params.push(user_id);
    }
    
    if (type) {
      query += ' AND n.type = $' + (params.length + 1);
      params.push(type.toUpperCase());
    }
    
    if (read_status !== undefined) {
      query += ' AND n.is_read = $' + (params.length + 1);
      params.push(read_status === 'true');
    }
    
    if (priority) {
      query += ' AND n.priority = $' + (params.length + 1);
      params.push(priority.toUpperCase());
    }
    
    query += ' ORDER BY n.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM notifications n WHERE 1=1';
    let countParams = [];
    
    if (user_id) {
      countQuery += ' AND n.user_id = $' + (countParams.length + 1);
      countParams.push(user_id);
    }
    if (type) {
      countQuery += ' AND n.type = $' + (countParams.length + 1);
      countParams.push(type.toUpperCase());
    }
    if (read_status !== undefined) {
      countQuery += ' AND n.is_read = $' + (countParams.length + 1);
      countParams.push(read_status === 'true');
    }
    if (priority) {
      countQuery += ' AND n.priority = $' + (countParams.length + 1);
      countParams.push(priority.toUpperCase());
    }
    
    const countResult = await db.query(countQuery, countParams);
    const totalNotifications = parseInt(countResult.rows[0].count);
    
    res.json({
      message: 'Notifications retrieved successfully',
      notifications: result.rows,
      pagination: {
        page,
        limit,
        total: totalNotifications,
        totalPages: Math.ceil(totalNotifications / limit),
        hasNext: page * limit < totalNotifications,
        hasPrev: page > 1
      },
      filters: {
        user_id: user_id || null,
        type: type || null,
        read_status: read_status || null,
        priority: priority || null
      }
    });
  } catch (error) {
    console.log('Database error for notifications:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve notifications - notifications table may not exist',
      error: error.message,
      suggestion: 'Create notifications table for notification management'
    });
  }
});

// Get notifications for a specific user
router.get('/user/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const unread_only = req.query.unread_only === 'true';
    const limit = parseInt(req.query.limit) || 50;
    
    let query = `
      SELECT n.id, n.title, n.message, n.type, n.priority, n.is_read,
             n.created_at, n.read_at, n.scheduled_for, n.data,
             sender.name as sender_name
      FROM notifications n
      LEFT JOIN users sender ON n.sender_id = sender.id
      WHERE n.user_id = $1
    `;
    let params = [user_id];
    
    if (unread_only) {
      query += ' AND n.is_read = false';
    }
    
    query += ' ORDER BY n.created_at DESC LIMIT $2';
    params.push(limit);
    
    const result = await db.query(query, params);
    
    // Get unread count
    const unreadResult = await db.query(
      'SELECT COUNT(*) as unread_count FROM notifications WHERE user_id = $1 AND is_read = false',
      [user_id]
    );
    
    res.json({
      message: 'User notifications retrieved successfully',
      notifications: result.rows,
      count: result.rows.length,
      unread_count: parseInt(unreadResult.rows[0]?.unread_count || 0),
      user_id,
      unread_only
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve user notifications',
      error: error.message
    });
  }
});

// Get notification by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(`
      SELECT n.*, 
             u.name as recipient_name, u.phone as recipient_phone, u.email as recipient_email,
             sender.name as sender_name, sender.phone as sender_phone
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      LEFT JOIN users sender ON n.sender_id = sender.id
      WHERE n.id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        message: 'Notification not found',
        id
      });
    }
    
    res.json({
      message: 'Notification retrieved successfully',
      notification: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve notification',
      error: error.message
    });
  }
});

// Create new notification
router.post('/create', async (req, res) => {
  try {
    const { 
      user_id, title, message, type = 'SYSTEM', priority = 'MEDIUM',
      sender_id = null, scheduled_for = null, data = null 
    } = req.body;
    
    if (!user_id || !title || !message) {
      return res.status(400).json({
        message: 'user_id, title, and message are required'
      });
    }
    
    const validTypes = ['APPOINTMENT', 'MEDICATION', 'EMERGENCY', 'SYSTEM', 'REMINDER', 'ALERT', 'INFO'];
    const validPriorities = ['HIGH', 'MEDIUM', 'LOW'];
    
    if (!validTypes.includes(type.toUpperCase())) {
      return res.status(400).json({
        message: 'Invalid notification type',
        validTypes
      });
    }
    
    if (!validPriorities.includes(priority.toUpperCase())) {
      return res.status(400).json({
        message: 'Invalid priority level',
        validPriorities
      });
    }
    
    // Verify user exists
    const userCheck = await db.query('SELECT id, name FROM users WHERE id = $1', [user_id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Recipient user not found' });
    }
    
    // Verify sender exists if provided
    if (sender_id) {
      const senderCheck = await db.query('SELECT id FROM users WHERE id = $1', [sender_id]);
      if (senderCheck.rows.length === 0) {
        return res.status(404).json({ message: 'Sender user not found' });
      }
    }
    
    const result = await db.query(`
      INSERT INTO notifications (
        user_id, title, message, type, priority, sender_id,
        scheduled_for, data, is_read, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, NOW())
      RETURNING *
    `, [user_id, title, message, type.toUpperCase(), priority.toUpperCase(),
        sender_id, scheduled_for, data]);
    
    res.status(201).json({
      message: 'Notification created successfully',
      notification: result.rows[0],
      recipient_name: userCheck.rows[0].name
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to create notification',
      error: error.message
    });
  }
});

// Mark notification as read
router.put('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(`
      UPDATE notifications SET 
        is_read = true,
        read_at = NOW()
      WHERE id = $1
      RETURNING id, title, is_read, read_at
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Notification not found' });
    }
    
    res.json({
      message: 'Notification marked as read',
      notification: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to mark notification as read',
      error: error.message
    });
  }
});

// Mark all notifications as read for a user
router.put('/user/:user_id/read-all', async (req, res) => {
  try {
    const { user_id } = req.params;
    
    const result = await db.query(`
      UPDATE notifications SET 
        is_read = true,
        read_at = NOW()
      WHERE user_id = $1 AND is_read = false
      RETURNING COUNT(*) as updated_count
    `, [user_id]);
    
    const updatedCount = result.rowCount || 0;
    
    res.json({
      message: 'All notifications marked as read',
      updated_count: updatedCount,
      user_id
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to mark all notifications as read',
      error: error.message
    });
  }
});

// Delete notification
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query('DELETE FROM notifications WHERE id = $1 RETURNING id, title', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Notification not found' });
    }
    
    res.json({
      message: 'Notification deleted successfully',
      deleted_notification: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to delete notification',
      error: error.message
    });
  }
});

// Send bulk notifications
router.post('/bulk', async (req, res) => {
  try {
    const { 
      user_ids, title, message, type = 'SYSTEM', 
      priority = 'MEDIUM', sender_id = null 
    } = req.body;
    
    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({
        message: 'user_ids array is required and must not be empty'
      });
    }
    
    if (!title || !message) {
      return res.status(400).json({
        message: 'title and message are required'
      });
    }
    
    // Verify all users exist
    const userCheck = await db.query(
      'SELECT id, name FROM users WHERE id = ANY($1)',
      [user_ids]
    );
    
    if (userCheck.rows.length !== user_ids.length) {
      const foundIds = userCheck.rows.map(user => user.id);
      const missingIds = user_ids.filter(id => !foundIds.includes(parseInt(id)));
      return res.status(404).json({
        message: 'Some users not found',
        missing_user_ids: missingIds
      });
    }
    
    // Create notifications for all users
    const notifications = user_ids.map(user_id => [
      user_id, title, message, type.toUpperCase(), priority.toUpperCase(), sender_id
    ]);
    
    const values = notifications.map((_, index) => {
      const offset = index * 6;
      return `(${offset + 1}, ${offset + 2}, ${offset + 3}, ${offset + 4}, ${offset + 5}, ${offset + 6}, false, NOW())`;
    }).join(', ');
    
    const flatParams = notifications.flat();
    
    const result = await db.query(`
      INSERT INTO notifications (user_id, title, message, type, priority, sender_id, is_read, created_at)
      VALUES ${values}
      RETURNING id, user_id
    `, flatParams);
    
    res.status(201).json({
      message: 'Bulk notifications sent successfully',
      notifications_sent: result.rows.length,
      notification_ids: result.rows.map(n => n.id),
      recipients: userCheck.rows.map(u => ({ id: u.id, name: u.name }))
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to send bulk notifications',
      error: error.message
    });
  }
});

// Get notification statistics
router.get('/stats/summary', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    
    const [totalStats, typeStats, priorityStats, recentActivity] = await Promise.all([
      // Total notification statistics
      db.query(`
        SELECT 
          COUNT(*) as total_notifications,
          COUNT(CASE WHEN is_read = false THEN 1 END) as unread_notifications,
          COUNT(CASE WHEN is_read = true THEN 1 END) as read_notifications,
          COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '${days} days' THEN 1 END) as recent_notifications
        FROM notifications
      `),
      
      // Type breakdown
      db.query(`
        SELECT type, COUNT(*) as count
        FROM notifications 
        WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY type
        ORDER BY count DESC
      `),
      
      // Priority breakdown
      db.query(`
        SELECT priority, COUNT(*) as count
        FROM notifications 
        WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY priority
        ORDER BY 
          CASE priority 
            WHEN 'HIGH' THEN 1 
            WHEN 'MEDIUM' THEN 2 
            WHEN 'LOW' THEN 3 
          END
      `),
      
      // Recent activity (daily counts)
      db.query(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM notifications 
        WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `)
    ]);
    
    res.json({
      message: 'Notification statistics retrieved successfully',
      statistics: {
        totals: totalStats.rows[0],
        by_type: typeStats.rows,
        by_priority: priorityStats.rows,
        daily_activity: recentActivity.rows
      },
      period_days: days,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve notification statistics',
      error: error.message
    });
  }
});

// Get scheduled notifications (for cron jobs)
router.get('/scheduled/pending', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT n.id, n.user_id, n.title, n.message, n.type, n.priority,
             n.scheduled_for, n.data,
             u.name as recipient_name, u.phone, u.email
      FROM notifications n
      JOIN users u ON n.user_id = u.id
      WHERE n.scheduled_for <= NOW() AND n.is_read = false
      ORDER BY n.scheduled_for ASC
      LIMIT 100
    `);
    
    res.json({
      message: 'Pending scheduled notifications retrieved',
      notifications: result.rows,
      count: result.rows.length,
      note: 'These notifications are ready to be sent'
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve scheduled notifications',
      error: error.message
    });
  }
});

// Get emergency notifications
router.get('/emergency/active', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT n.id, n.title, n.message, n.created_at, n.data,
             u.name as recipient_name, u.phone
      FROM notifications n
      JOIN users u ON n.user_id = u.id
      WHERE n.type = 'EMERGENCY' AND n.priority = 'HIGH'
        AND n.created_at >= CURRENT_DATE - INTERVAL '24 hours'
      ORDER BY n.created_at DESC
    `);
    
    res.json({
      message: 'Active emergency notifications retrieved',
      emergency_notifications: result.rows,
      count: result.rows.length,
      period: 'Last 24 hours'
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve emergency notifications',
      error: error.message
    });
  }
});

export default router;