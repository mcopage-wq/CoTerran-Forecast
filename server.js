// server.js
const fastify = require('fastify')({ logger: true });
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// Environment configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const PORT = process.env.PORT || 3001;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Plugins
fastify.register(require('@fastify/cors'), {
  origin: process.env.FRONTEND_URL || 'https://coterran-forecast-frontend-production.up.railway.app',
  credentials: true
});

fastify.register(require('@fastify/jwt'), {
  secret: JWT_SECRET
});

// Authentication decorator
fastify.decorate('authenticate', async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

// Admin check decorator
fastify.decorate('requireAdmin', async (request, reply) => {
  await fastify.authenticate(request, reply);
  const result = await pool.query(
    'SELECT is_admin FROM users WHERE id = $1',
    [request.user.userId]
  );
  if (!result.rows[0]?.is_admin) {
    reply.code(403).send({ error: 'Admin access required' });
  }
});

// ============================================
// AUTH ROUTES
// ============================================

// Register new expert
fastify.post('/api/auth/register', async (request, reply) => {
  const { email, password, fullName, organization, expertiseArea, bio } = request.body;

  // Validation
  if (!email || !password || !fullName) {
    return reply.code(400).send({ error: 'Missing required fields' });
  }

  if (password.length < 8) {
    return reply.code(400).send({ error: 'Password must be at least 8 characters' });
  }

  try {
    // Check if user exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return reply.code(400).send({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user (requires approval)
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, organization, expertise_area, bio, is_approved)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       RETURNING id, email, full_name, organization, expertise_area, is_approved`,
      [email, passwordHash, fullName, organization, expertiseArea, bio]
    );

    reply.send({
      message: 'Registration successful. Your account is pending approval.',
      user: result.rows[0]
    });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Registration failed' });
  }
});

// Login
fastify.post('/api/auth/login', async (request, reply) => {
  const { email, password } = request.body;

  if (!email || !password) {
    return reply.code(400).send({ error: 'Email and password required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, full_name, organization, is_admin, is_approved FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    if (!user.is_approved && !user.is_admin) {
      return reply.code(403).send({ error: 'Account pending approval' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    const token = fastify.jwt.sign({
      userId: user.id,
      email: user.email,
      isAdmin: user.is_admin
    });

    reply.send({
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,        // ✅ snake_case
        organization: user.organization,
        is_admin: user.is_admin          // ✅ snake_case
      }
    });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Login failed' });
  }
});

// Get current user
fastify.get('/api/auth/me', {
  onRequest: [fastify.authenticate]
}, async (request, reply) => {
  try {
    const result = await pool.query(
      `SELECT id, email, full_name, organization, expertise_area, bio, 
              is_admin, total_predictions, accuracy_score, rank, created_at
       FROM users WHERE id = $1`,
      [request.user.userId]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found' });
    }

    reply.send({ user: result.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch user' });
  }
});

// ============================================
// MARKET ROUTES
// ============================================

// List all markets
fastify.get('/api/markets', async (request, reply) => {
  const { status, category, limit = 50, offset = 0 } = request.query;

  try {
    let query = `
      SELECT m.*, 
             u.full_name as creator_name,
             ma.median_prediction,
             ma.mean_prediction,
             ma.std_deviation
      FROM markets m
      LEFT JOIN users u ON m.created_by = u.id
      LEFT JOIN market_aggregates ma ON m.id = ma.market_id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (status) {
      query += ` AND m.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    if (category) {
      query += ` AND m.category = $${paramCount}`;
      params.push(category);
      paramCount++;
    }

    query += ` ORDER BY m.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    reply.send({ markets: result.rows });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch markets' });
  }
});

// Get single market with predictions
fastify.get('/api/markets/:id', async (request, reply) => {
  const { id } = request.params;

  try {
    // Get market
    const marketResult = await pool.query(
      `SELECT m.*, 
              u.full_name as creator_name,
              ma.median_prediction,
              ma.mean_prediction,
              ma.std_deviation
       FROM markets m
       LEFT JOIN users u ON m.created_by = u.id
       LEFT JOIN market_aggregates ma ON m.id = ma.market_id
       WHERE m.id = $1`,
      [id]
    );

    if (marketResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Market not found' });
    }

    const market = marketResult.rows[0];

    // Get predictions (anonymized unless user is admin or it's their own)
    const userId = request.user?.userId;
    const predictionsResult = await pool.query(
      `SELECT p.id, p.prediction, p.confidence, p.reasoning, p.created_at,
              CASE 
                WHEN p.user_id = $2 OR $3 = true OR p.is_public = true 
                THEN u.full_name 
                ELSE 'Anonymous' 
              END as predictor_name,
              CASE 
                WHEN p.user_id = $2 THEN true 
                ELSE false 
              END as is_mine
       FROM predictions p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.market_id = $1
       ORDER BY p.created_at DESC`,
      [id, userId, request.user?.isAdmin || false]
    );

    reply.send({
      market,
      predictions: predictionsResult.rows
    });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch market' });
  }
});

// Create market (admin only)
fastify.post('/api/markets', {
  onRequest: [fastify.requireAdmin]
}, async (request, reply) => {
  const {
    question,
    description,
    category,
    closeDate,
    dataSource,
    resolutionCriteria
  } = request.body;

  if (!question || !category || !closeDate || !resolutionCriteria) {
    return reply.code(400).send({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO markets 
       (question, description, category, close_date, data_source, resolution_criteria, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [question, description, category, closeDate, dataSource, resolutionCriteria, request.user.userId]
    );

    // Log audit
    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'market_created', 'market', $2, $3)`,
      [request.user.userId, result.rows[0].id, JSON.stringify({ question })]
    );

    reply.code(201).send({ market: result.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to create market' });
  }
});

// Resolve market (admin only)
fastify.post('/api/markets/:id/resolve', {
  onRequest: [fastify.requireAdmin]
}, async (request, reply) => {
  const { id } = request.params;
  const { outcome, resolutionSource, resolutionNotes } = request.body;

  if (outcome === undefined || outcome < 0 || outcome > 100) {
    return reply.code(400).send({ error: 'Outcome must be between 0 and 100' });
  }

  try {
    const result = await pool.query(
      `UPDATE markets 
       SET status = 'resolved', 
           outcome = $1, 
           resolution_source = $2,
           resolution_notes = $3,
           resolution_date = NOW(),
           resolved_by = $4
       WHERE id = $5
       RETURNING *`,
      [outcome, resolutionSource, resolutionNotes, request.user.userId, id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Market not found' });
    }

    // Audit log
    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'market_resolved', 'market', $2, $3)`,
      [request.user.userId, id, JSON.stringify({ outcome, resolutionSource })]
    );

    reply.send({ market: result.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to resolve market' });
  }
});

// ============================================
// PREDICTION ROUTES
// ============================================

// Submit or update prediction
fastify.post('/api/predictions', {
  onRequest: [fastify.authenticate]
}, async (request, reply) => {
  const { marketId, prediction, confidence, reasoning, isPublic = true } = request.body;

  if (!marketId || prediction === undefined) {
    return reply.code(400).send({ error: 'Market ID and prediction required' });
  }

  if (prediction < 0 || prediction > 100) {
    return reply.code(400).send({ error: 'Prediction must be between 0 and 100' });
  }

  try {
    // Check market is open
    const marketCheck = await pool.query(
      'SELECT status, close_date FROM markets WHERE id = $1',
      [marketId]
    );

    if (marketCheck.rows.length === 0) {
      return reply.code(404).send({ error: 'Market not found' });
    }

    if (marketCheck.rows[0].status !== 'open') {
      return reply.code(400).send({ error: 'Market is not open' });
    }

    if (new Date(marketCheck.rows[0].close_date) < new Date()) {
      return reply.code(400).send({ error: 'Market has closed' });
    }

    // Insert or update prediction
    const result = await pool.query(
      `INSERT INTO predictions 
       (market_id, user_id, prediction, confidence, reasoning, is_public)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (market_id, user_id) 
       DO UPDATE SET 
         prediction = $3,
         confidence = $4,
         reasoning = $5,
         is_public = $6,
         updated_at = NOW()
       RETURNING *`,
      [marketId, request.user.userId, prediction, confidence, reasoning, isPublic]
    );

    // Update market prediction count
    await pool.query(
      `UPDATE markets 
       SET prediction_count = (SELECT COUNT(*) FROM predictions WHERE market_id = $1)
       WHERE id = $1`,
      [marketId]
    );

    reply.send({ prediction: result.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to submit prediction' });
  }
});

// Get user's predictions
fastify.get('/api/predictions/mine', {
  onRequest: [fastify.authenticate]
}, async (request, reply) => {
  try {
    const result = await pool.query(
      `SELECT p.*, m.question, m.category, m.status, m.outcome, m.close_date
       FROM predictions p
       JOIN markets m ON p.market_id = m.id
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC`,
      [request.user.userId]
    );

    reply.send({ predictions: result.rows });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch predictions' });
  }
});

// ============================================
// LEADERBOARD ROUTES
// ============================================

// Get leaderboard
fastify.get('/api/leaderboard', async (request, reply) => {
  const { limit = 50, period = 'all' } = request.query;

  try {
    const result = await pool.query(
      `SELECT 
         u.id,
         u.full_name,
         u.organization,
         u.expertise_area,
         u.total_predictions,
         u.accuracy_score,
         ROW_NUMBER() OVER (ORDER BY u.accuracy_score DESC NULLS LAST) as rank
       FROM users u
       WHERE u.is_approved = true AND u.total_predictions > 0
       ORDER BY u.accuracy_score DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );

    reply.send({ leaderboard: result.rows });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch leaderboard' });
  }
});

// ============================================
// ADMIN ROUTES
// ============================================

// Approve user
fastify.post('/api/admin/users/:id/approve', {
  onRequest: [fastify.requireAdmin]
}, async (request, reply) => {
  const { id } = request.params;

  try {
    const result = await pool.query(
      'UPDATE users SET is_approved = true WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found' });
    }

    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id)
       VALUES ($1, 'user_approved', 'user', $2)`,
      [request.user.userId, id]
    );

    reply.send({ user: result.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to approve user' });
  }
});

// List pending users
fastify.get('/api/admin/users/pending', {
  onRequest: [fastify.requireAdmin]
}, async (request, reply) => {
  try {
    const result = await pool.query(
      `SELECT id, email, full_name, organization, expertise_area, bio, created_at
       FROM users
       WHERE is_approved = false AND is_admin = false
       ORDER BY created_at ASC`
    );

    reply.send({ users: result.rows });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch pending users' });
  }
});

// Analytics endpoint
fastify.get('/api/admin/analytics', {
  onRequest: [fastify.requireAdmin]
}, async (request, reply) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE is_approved = true) as total_experts,
        (SELECT COUNT(*) FROM markets) as total_markets,
        (SELECT COUNT(*) FROM markets WHERE status = 'open') as open_markets,
        (SELECT COUNT(*) FROM markets WHERE status = 'resolved') as resolved_markets,
        (SELECT COUNT(*) FROM predictions) as total_predictions,
        (SELECT AVG(prediction_count) FROM markets WHERE status = 'open') as avg_predictions_per_market
    `);

    reply.send({ analytics: stats.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch analytics' });
  }
});

// ============================================
// START SERVER
// ============================================

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`Server listening on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

// Export for testing
module.exports = fastify;