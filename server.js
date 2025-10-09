// server.js
const fastify = require('fastify')({ logger: true });
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// Environment configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const PORT = process.env.PORT || 3001;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@coterran.co';

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

// Helper function to get display name
function getDisplayName(user) {
  if (user.use_anonymous) {
    return user.display_name || `Expert ${user.id.substring(0, 8)}`;
  }
  return user.full_name;
}

// Helper function to generate anonymous identifier
function generateAnonymousId(userId) {
  // Create a consistent but anonymous identifier based on user ID
  const hash = require('crypto').createHash('sha256').update(userId).digest('hex');
  return `Expert-${hash.substring(0, 8)}`;
}

// Update the getDisplayName function
function getDisplayName(user) {
  if (user.use_anonymous) {
    return generateAnonymousId(user.id);
  }
  return user.display_name || user.full_name;
}

// ============================================
// AUTH ROUTES
// ============================================

// Register new expert
fastify.post('/api/auth/register', async (request, reply) => {
  const { email, password, fullName, organization, expertiseArea, bio } = request.body;

  if (!email || !password || !fullName || !organization) {
    return reply.code(400).send({ error: 'Missing required fields' });
  }

  if (password.length < 8) {
    return reply.code(400).send({ error: 'Password must be at least 8 characters' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return reply.code(400).send({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, organization, expertise_area, bio, is_approved)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       RETURNING id, email, full_name, organization, expertise_area, is_approved`,
      [email, passwordHash, fullName, organization, expertiseArea || null, bio || null]
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
      `SELECT id, email, password_hash, full_name, organization, is_admin, is_approved, 
              use_anonymous, display_name 
       FROM users WHERE email = $1`,
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
        full_name: user.full_name,
        organization: user.organization,
        is_admin: user.is_admin,
        use_anonymous: user.use_anonymous || false,
        display_name: user.display_name
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
              is_admin, use_anonymous, display_name, total_predictions, 
              accuracy_score, rank, created_at
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

// Password reset request
fastify.post('/api/auth/reset-password-request', async (request, reply) => {
  const { email } = request.body;

  if (!email) {
    return reply.code(400).send({ error: 'Email required' });
  }

  try {
    const result = await pool.query('SELECT id, full_name FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      // Don't reveal if email exists
      return reply.send({ message: 'If the email exists, a reset link has been sent' });
    }

    // Generate reset token (expires in 1 hour)
    const resetToken = fastify.jwt.sign(
      { userId: result.rows[0].id, type: 'password-reset' },
      { expiresIn: '1h' }
    );

    // In production, send email here
    // For now, log it (in production, use a proper email service)
    fastify.log.info(`Password reset token for ${email}: ${resetToken}`);
    fastify.log.info(`Reset link: ${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`);

    // TODO: Send email with reset link
    // await sendEmail(email, 'Password Reset', `Reset link: ${resetLink}`);

    reply.send({ 
      message: 'If the email exists, a reset link has been sent',
      // Remove this in production - only for testing
      _dev_token: process.env.NODE_ENV === 'development' ? resetToken : undefined
    });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to process request' });
  }
});

// ============================================
// USER PROFILE ROUTES
// ============================================

// Update profile
fastify.put('/api/users/profile', {
  onRequest: [fastify.authenticate]
}, async (request, reply) => {
  const { useAnonymous, displayName } = request.body;

  try {
    const result = await pool.query(
      `UPDATE users 
       SET use_anonymous = $1, display_name = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, email, full_name, organization, is_admin, use_anonymous, display_name`,
      [useAnonymous, displayName, request.user.userId]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found' });
    }

    reply.send({ user: result.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to update profile' });
  }
});

// Change password
fastify.post('/api/users/change-password', {
  onRequest: [fastify.authenticate]
}, async (request, reply) => {
  const { currentPassword, newPassword } = request.body;

  if (!currentPassword || !newPassword) {
    return reply.code(400).send({ error: 'Current and new password required' });
  }

  if (newPassword.length < 8) {
    return reply.code(400).send({ error: 'Password must be at least 8 characters' });
  }

  try {
    const result = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [request.user.userId]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const validPassword = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!validPassword) {
      return reply.code(401).send({ error: 'Current password is incorrect' });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newPasswordHash, request.user.userId]
    );

    reply.send({ message: 'Password changed successfully' });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to change password' });
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
             CASE 
               WHEN u.use_anonymous THEN COALESCE(u.display_name, 'Expert ' || SUBSTRING(u.id::text, 1, 8))
               ELSE u.full_name 
             END as creator_name,
             (SELECT COUNT(*) FROM predictions WHERE market_id = m.id) as prediction_count,
             (SELECT COUNT(*) FROM comments WHERE market_id = m.id) as comment_count,
             (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY prediction) 
              FROM predictions WHERE market_id = m.id) as median_prediction,
             (SELECT AVG(prediction) FROM predictions WHERE market_id = m.id) as mean_prediction
      FROM markets m
      LEFT JOIN users u ON m.created_by = u.id
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
    const marketResult = await pool.query(
      `SELECT m.*, 
              CASE 
                WHEN u.use_anonymous THEN COALESCE(u.display_name, 'Expert ' || SUBSTRING(u.id::text, 1, 8))
                ELSE u.full_name 
              END as creator_name,
              (SELECT COUNT(*) FROM predictions WHERE market_id = m.id) as prediction_count,
              (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY prediction) 
               FROM predictions WHERE market_id = m.id) as median_prediction,
              (SELECT AVG(prediction) FROM predictions WHERE market_id = m.id) as mean_prediction
       FROM markets m
       LEFT JOIN users u ON m.created_by = u.id
       WHERE m.id = $1`,
      [id]
    );

    if (marketResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Market not found' });
    }

    const market = marketResult.rows[0];
    const userId = request.user?.userId;
    const isAdmin = request.user?.isAdmin || false;

    const predictionsResult = await pool.query(
      `SELECT p.id, p.prediction, p.confidence, p.reasoning, p.created_at, p.updated_at,
              CASE 
                WHEN p.user_id = $2 THEN u.full_name
                WHEN $3 = true THEN u.full_name
                WHEN u.use_anonymous THEN COALESCE(u.display_name, 'Expert ' || SUBSTRING(u.id::text, 1, 8))
                ELSE u.full_name
              END as predictor_name,
              CASE 
                WHEN p.user_id = $2 THEN true 
                ELSE false 
              END as is_mine
       FROM predictions p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.market_id = $1
       ORDER BY p.created_at DESC`,
      [id, userId, isAdmin]
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
  const { question, description, category, closeDate, dataSource, resolutionCriteria } = request.body;

  if (!question || !category || !closeDate || !resolutionCriteria) {
    return reply.code(400).send({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO markets 
       (question, description, category, close_date, data_source, resolution_criteria, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
       RETURNING *`,
      [question, description, category, closeDate, dataSource, resolutionCriteria, request.user.userId]
    );

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

// Propose market (any authenticated user)
fastify.post('/api/markets/propose', {
  onRequest: [fastify.authenticate]
}, async (request, reply) => {
  const { question, description, category, closeDate, dataSource, resolutionCriteria } = request.body;

  if (!question || !category || !closeDate || !resolutionCriteria || !dataSource) {
    return reply.code(400).send({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO pending_markets 
       (question, description, category, close_date, data_source, resolution_criteria, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING *`,
      [question, description, category, closeDate, dataSource, resolutionCriteria, request.user.userId]
    );

    reply.code(201).send({ 
      message: 'Market proposal submitted for admin approval',
      market: result.rows[0] 
    });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to propose market' });
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

    // Calculate Brier scores for all predictions
    await pool.query(`
      UPDATE predictions 
      SET brier_score = POWER((prediction / 100.0) - ($1 / 100.0), 2)
      WHERE market_id = $2
    `, [outcome, id]);

    // Update user statistics
    await pool.query(`
      UPDATE users u
      SET 
        total_predictions = (SELECT COUNT(*) FROM predictions WHERE user_id = u.id),
        accuracy_score = (
          SELECT AVG(brier_score) 
          FROM predictions 
          WHERE user_id = u.id AND brier_score IS NOT NULL
        )
      WHERE id IN (SELECT DISTINCT user_id FROM predictions WHERE market_id = $1)
    `, [id]);

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
// PREDICTION ROUTES (UPDATED WITH ODDS TRACKING)
// ============================================

// Submit prediction
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

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const marketCheck = await client.query(
      'SELECT status, close_date FROM markets WHERE id = $1',
      [marketId]
    );

    if (marketCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return reply.code(404).send({ error: 'Market not found' });
    }

    if (marketCheck.rows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return reply.code(400).send({ error: 'Market is not open' });
    }

    if (new Date(marketCheck.rows[0].close_date) < new Date()) {
      await client.query('ROLLBACK');
      return reply.code(400).send({ error: 'Market has closed' });
    }

    // Check if prediction already exists
    const existing = await client.query(
      'SELECT id FROM predictions WHERE market_id = $1 AND user_id = $2',
      [marketId, request.user.userId]
    );

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return reply.code(400).send({ error: 'You have already submitted a prediction for this market. Use the update endpoint to modify it.' });
    }

    const result = await client.query(
      `INSERT INTO predictions 
       (market_id, user_id, prediction, confidence, reasoning, is_public)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [marketId, request.user.userId, prediction, confidence, reasoning, isPublic]
    );

    // ✨ NEW: Record odds change for analytics
    await client.query(
      'SELECT record_odds_change($1, $2)',
      [marketId, 'new_prediction']
    );

    await client.query('COMMIT');

    reply.send({ prediction: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to submit prediction' });
  } finally {
    client.release();
  }
});

// Update prediction
fastify.post('/api/predictions/update', {
  onRequest: [fastify.authenticate]
}, async (request, reply) => {
  const { marketId, newPrediction, reasoning, sources } = request.body;

  if (!marketId || newPrediction === undefined || !reasoning) {
    return reply.code(400).send({ error: 'Market ID, new prediction, and reasoning required' });
  }

  if (newPrediction < 0 || newPrediction > 100) {
    return reply.code(400).send({ error: 'Prediction must be between 0 and 100' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const marketCheck = await client.query(
      'SELECT status, close_date FROM markets WHERE id = $1',
      [marketId]
    );

    if (marketCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return reply.code(404).send({ error: 'Market not found' });
    }

    if (marketCheck.rows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return reply.code(400).send({ error: 'Market is not open' });
    }

    // Get current prediction
    const currentPred = await client.query(
      'SELECT id, prediction FROM predictions WHERE market_id = $1 AND user_id = $2',
      [marketId, request.user.userId]
    );

    if (currentPred.rows.length === 0) {
      await client.query('ROLLBACK');
      return reply.code(404).send({ error: 'No existing prediction found' });
    }

    const oldPrediction = currentPred.rows[0].prediction;
    const predictionId = currentPred.rows[0].id;

    // Record the update in history
    await client.query(
      `INSERT INTO prediction_updates 
       (prediction_id, old_prediction, new_prediction, reasoning, sources)
       VALUES ($1, $2, $3, $4, $5)`,
      [predictionId, oldPrediction, newPrediction, reasoning, sources]
    );

    // Update the prediction
    const result = await client.query(
      `UPDATE predictions 
       SET prediction = $1, reasoning = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [newPrediction, reasoning, predictionId]
    );

    // ✨ NEW: Record odds change for analytics
    await client.query(
      'SELECT record_odds_change($1, $2)',
      [marketId, 'updated_prediction']
    );

    await client.query('COMMIT');

    reply.send({ prediction: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to update prediction' });
  } finally {
    client.release();
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
// COMMENT ROUTES
// ============================================

// Get comments for a market
fastify.get('/api/markets/:id/comments', async (request, reply) => {
  const { id } = request.params;

  try {
    const result = await pool.query(
      `SELECT c.id, c.content, c.created_at, c.parent_id,
              CASE 
                WHEN u.use_anonymous THEN COALESCE(u.display_name, 'Expert ' || SUBSTRING(u.id::text, 1, 8))
                ELSE u.full_name 
              END as author_name,
              u.id as user_id
       FROM comments c
       LEFT JOIN users u ON c.user_id = u.id
       WHERE c.market_id = $1
       ORDER BY c.created_at ASC`,
      [id]
    );

    // Organize comments with replies
    const comments = result.rows.filter(c => !c.parent_id);
    const replies = result.rows.filter(c => c.parent_id);

    comments.forEach(comment => {
      comment.replies = replies.filter(r => r.parent_id === comment.id);
    });

    reply.send({ comments });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch comments' });
  }
});

// Post comment
fastify.post('/api/markets/:id/comments', {
  onRequest: [fastify.authenticate]
}, async (request, reply) => {
  const { id } = request.params;
  const { content, parentId } = request.body;

  if (!content || content.trim().length === 0) {
    return reply.code(400).send({ error: 'Comment content required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO comments (market_id, user_id, content, parent_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, request.user.userId, content.trim(), parentId || null]
    );

    reply.code(201).send({ comment: result.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to post comment' });
  }
});

// ============================================
// LEADERBOARD ROUTES
// ============================================

// Get leaderboard
fastify.get('/api/leaderboard', async (request, reply) => {
  const { limit = 50 } = request.query;

  try {
    const result = await pool.query(
      `WITH ranked_users AS (
         SELECT 
           u.id as user_id,
           u.full_name as display_name,
           COUNT(p.id) FILTER (WHERE u.use_anonymous = false OR p.created_at < (
             SELECT MIN(updated_at) FROM users WHERE id = u.id AND use_anonymous = true
           )) as total_predictions,
           COUNT(CASE WHEN m.status = 'resolved' AND (u.use_anonymous = false OR p.created_at < (
             SELECT MIN(updated_at) FROM users WHERE id = u.id AND use_anonymous = true
           )) THEN 1 END) as resolved_predictions,
           AVG(CASE WHEN p.brier_score IS NOT NULL AND (u.use_anonymous = false OR p.created_at < (
             SELECT MIN(updated_at) FROM users WHERE id = u.id AND use_anonymous = true
           )) THEN 1 - p.brier_score END) as average_accuracy,
           AVG(CASE WHEN u.use_anonymous = false OR p.created_at < (
             SELECT MIN(updated_at) FROM users WHERE id = u.id AND use_anonymous = true
           ) THEN p.brier_score END) as brier_score,
           ROW_NUMBER() OVER (ORDER BY AVG(CASE WHEN u.use_anonymous = false OR p.created_at < (
             SELECT MIN(updated_at) FROM users WHERE id = u.id AND use_anonymous = true
           ) THEN p.brier_score END) ASC NULLS LAST) as rank
         FROM users u
         LEFT JOIN predictions p ON u.id = p.user_id
         LEFT JOIN markets m ON p.market_id = m.id
         WHERE u.is_approved = true
         GROUP BY u.id, u.full_name
         HAVING COUNT(CASE WHEN u.use_anonymous = false OR p.created_at < (
           SELECT MIN(updated_at) FROM users WHERE id = u.id AND use_anonymous = true
         ) THEN p.id END) > 0
       )
       SELECT * FROM ranked_users
       ORDER BY rank
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

// List pending markets
fastify.get('/api/admin/markets/pending', {
  onRequest: [fastify.requireAdmin]
}, async (request, reply) => {
  try {
    const result = await pool.query(
      `SELECT pm.*, u.full_name as creator_name
       FROM pending_markets pm
       LEFT JOIN users u ON pm.created_by = u.id
       WHERE pm.status = 'pending'
       ORDER BY pm.created_at ASC`
    );

    reply.send({ markets: result.rows });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch pending markets' });
  }
});

// Approve market
fastify.post('/api/admin/markets/:id/approve', {
  onRequest: [fastify.requireAdmin]
}, async (request, reply) => {
  const { id } = request.params;
  const updatedData = request.body || {};

  try {
    // Get pending market
    const pendingResult = await pool.query(
      'SELECT * FROM pending_markets WHERE id = $1',
      [id]
    );

    if (pendingResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Pending market not found' });
    }

    const pending = pendingResult.rows[0];

    // Create actual market with optional admin updates
    const result = await pool.query(
      `INSERT INTO markets 
       (question, description, category, close_date, data_source, resolution_criteria, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
       RETURNING *`,
      [
        updatedData.question || pending.question,
        updatedData.description || pending.description,
        updatedData.category || pending.category,
        updatedData.closeDate || pending.close_date,
        updatedData.dataSource || pending.data_source,
        updatedData.resolutionCriteria || pending.resolution_criteria,
        pending.created_by
      ]
    );

    // Mark as approved
    await pool.query(
      `UPDATE pending_markets SET status = 'approved' WHERE id = $1`,
      [id]
    );

    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'market_approved', 'market', $2, $3)`,
      [request.user.userId, result.rows[0].id, JSON.stringify({ original_proposal: id })]
    );

    reply.send({ market: result.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to approve market' });
  }
});

// Reject market
fastify.post('/api/admin/markets/:id/reject', {
  onRequest: [fastify.requireAdmin]
}, async (request, reply) => {
  const { id } = request.params;
  const { reason } = request.body;

  try {
    const result = await pool.query(
      `UPDATE pending_markets 
       SET status = 'rejected', rejection_reason = $1
       WHERE id = $2
       RETURNING *`,
      [reason, id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Pending market not found' });
    }

    // TODO: Send email notification to creator

    reply.send({ message: 'Market proposal rejected', market: result.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to reject market' });
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
        (SELECT COUNT(*) FROM pending_markets WHERE status = 'pending') as pending_markets,
        (SELECT COUNT(*) FROM users WHERE is_approved = false) as pending_users,
        (SELECT AVG(prediction_count) FROM (
          SELECT COUNT(*) as prediction_count 
          FROM predictions 
          GROUP BY market_id
        ) as counts) as avg_predictions_per_market
    `);

    reply.send({ analytics: stats.rows[0] });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch analytics' });
  }
});

// ============================================
// ANALYTICS & ODDS ROUTES
// Add these routes to your server.js file
// Place them BEFORE the "START SERVER" section
// ============================================

// Get current odds for a market
fastify.get('/api/markets/:id/odds', async (request, reply) => {
  const { id } = request.params;

  try {
    const result = await pool.query(
      `SELECT 
        m.id,
        m.question,
        COUNT(p.id) as prediction_count,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.prediction) as median_prediction,
        AVG(p.prediction) as mean_prediction,
        STDDEV(p.prediction) as std_deviation,
        -- Calculate current odds
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.prediction) as probability,
        CASE 
          WHEN PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.prediction) > 0 
          THEN 100.0 / PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.prediction)
          ELSE NULL 
        END as decimal_odds,
        -- Fractional odds (simplified)
        CASE 
          WHEN PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.prediction) > 0 
          THEN ROUND(100 - PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.prediction))
          ELSE NULL 
        END as fractional_numerator,
        CASE 
          WHEN PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.prediction) > 0 
          THEN ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.prediction))
          ELSE NULL 
        END as fractional_denominator,
        -- Confidence distribution
        COUNT(*) FILTER (WHERE p.confidence = 'high') as high_confidence_count,
        COUNT(*) FILTER (WHERE p.confidence = 'medium') as medium_confidence_count,
        COUNT(*) FILTER (WHERE p.confidence = 'low') as low_confidence_count
      FROM markets m
      LEFT JOIN predictions p ON m.id = p.market_id
      WHERE m.id = $1
      GROUP BY m.id, m.question`,
      [id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Market not found' });
    }

    const odds = result.rows[0];
    
    // Format the response
    reply.send({
      marketId: odds.id,
      question: odds.question,
      predictionCount: parseInt(odds.prediction_count, 10) || 0,
      statistics: {
        median: odds.median_prediction ? parseFloat(odds.median_prediction) : null,
        mean: odds.mean_prediction ? parseFloat(odds.mean_prediction) : null,
        stdDeviation: odds.std_deviation ? parseFloat(odds.std_deviation) : null
      },
      odds: {
        probability: odds.probability ? parseFloat(odds.probability) : null,
        decimal: odds.decimal_odds ? parseFloat(odds.decimal_odds) : null,
        fractional: odds.fractional_numerator && odds.fractional_denominator 
          ? `${odds.fractional_numerator}:${odds.fractional_denominator}`
          : null,
        impliedProbability: odds.probability ? parseFloat(odds.probability) : null
      },
      confidence: {
        high: parseInt(odds.high_confidence_count, 10) || 0,
        medium: parseInt(odds.medium_confidence_count, 10) || 0,
        low: parseInt(odds.low_confidence_count, 10) || 0
      }
    });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch odds' });
  }
});

// Get analytics for a market with time period
fastify.get('/api/markets/:id/analytics', async (request, reply) => {
  const { id } = request.params;
  const { period = 'daily', limit = 30 } = request.query;

  try {
    // Validate period
    const validPeriods = ['daily', 'weekly', 'monthly', '3-monthly', 'annual'];
    if (!validPeriods.includes(period)) {
      return reply.code(400).send({ error: 'Invalid period' });
    }

    // Get snapshots for the period
    let snapshotQuery;
    let snapshotParams = [id];

    if (period === 'daily') {
      snapshotQuery = `
        SELECT * FROM market_snapshots
        WHERE market_id = $1 AND snapshot_type = 'daily'
        ORDER BY snapshot_date DESC
        LIMIT $2
      `;
      snapshotParams.push(limit);
    } else if (period === 'weekly') {
      snapshotQuery = `
        SELECT * FROM market_snapshots
        WHERE market_id = $1 AND snapshot_type = 'weekly'
        ORDER BY snapshot_date DESC
        LIMIT $2
      `;
      snapshotParams.push(limit);
    } else if (period === 'monthly') {
      snapshotQuery = `
        SELECT * FROM market_snapshots
        WHERE market_id = $1 AND snapshot_type = 'monthly'
        ORDER BY snapshot_date DESC
        LIMIT $2
      `;
      snapshotParams.push(limit);
    } else if (period === '3-monthly') {
      // Quarterly: January, April, July, October
      snapshotQuery = `
        SELECT * FROM market_snapshots
        WHERE market_id = $1 
          AND snapshot_type = 'monthly'
          AND EXTRACT(MONTH FROM snapshot_date) IN (1, 4, 7, 10)
        ORDER BY snapshot_date DESC
        LIMIT $2
      `;
      snapshotParams.push(limit);
    } else if (period === 'annual') {
      // Annual: January snapshots only
      snapshotQuery = `
        SELECT * FROM market_snapshots
        WHERE market_id = $1 
          AND snapshot_type = 'monthly'
          AND EXTRACT(MONTH FROM snapshot_date) = 1
        ORDER BY snapshot_date DESC
        LIMIT $2
      `;
      snapshotParams.push(limit);
    }
    
    // Note: Monthly snapshots are preserved for future multi-year and decadal analysis
    // Additional periods can be added by querying monthly snapshots with different filters:
    // - 5-year: Monthly snapshots from last 60 months
    // - Decadal: Annual snapshots (Jan only) from last 10+ years

    const snapshots = await pool.query(snapshotQuery, snapshotParams);

    // Get real-time odds history for more granular data
    const oddsHistory = await pool.query(
      `SELECT * FROM market_odds_history
       WHERE market_id = $1
       ORDER BY timestamp DESC
       LIMIT 100`,
      [id]
    );

    // Get market info
    const marketInfo = await pool.query(
      `SELECT question, category, status, created_at, close_date
       FROM markets WHERE id = $1`,
      [id]
    );

    if (marketInfo.rows.length === 0) {
      return reply.code(404).send({ error: 'Market not found' });
    }

    reply.send({
      market: marketInfo.rows[0],
      period,
      snapshots: snapshots.rows.map(s => ({
        date: s.snapshot_date,
        predictionCount: s.prediction_count,
        median: parseFloat(s.median_prediction),
        mean: parseFloat(s.mean_prediction),
        stdDeviation: parseFloat(s.std_deviation),
        odds: {
          probability: parseFloat(s.probability),
          decimal: parseFloat(s.decimal_odds),
          fractional: s.fractional_odds_numerator && s.fractional_odds_denominator
            ? `${s.fractional_odds_numerator}:${s.fractional_odds_denominator}`
            : null
        },
        confidence: {
          high: s.high_confidence_count,
          medium: s.medium_confidence_count,
          low: s.low_confidence_count
        },
        distribution: {
          range_0_25: s.predictions_0_25,
          range_25_50: s.predictions_25_50,
          range_50_75: s.predictions_50_75,
          range_75_100: s.predictions_75_100
        }
      })),
      recentChanges: oddsHistory.rows.slice(0, 20).map(h => ({
        timestamp: h.timestamp,
        triggerType: h.trigger_type,
        predictionCount: h.prediction_count,
        probability: parseFloat(h.probability),
        decimalOdds: parseFloat(h.decimal_odds),
        change: parseFloat(h.probability_change)
      }))
    });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch analytics' });
  }
});

// Get odds history (real-time changes)
fastify.get('/api/markets/:id/odds-history', async (request, reply) => {
  const { id } = request.params;
  const { limit = 100, hours = 24 } = request.query;

  try {
    const hoursInt = parseInt(hours, 10);
    const limitInt = parseInt(limit, 10);
    
    const result = await pool.query(
      `SELECT * FROM market_odds_history
       WHERE market_id = $1
         AND timestamp >= NOW() - INTERVAL '1 hour' * $2
       ORDER BY timestamp DESC
       LIMIT $3`,
      [id, hoursInt, limitInt]
    );

    reply.send({
      marketId: id,
      timeRange: `${hours} hours`,
      changes: result.rows.map(h => ({
        timestamp: h.timestamp,
        triggerType: h.trigger_type,
        predictionCount: h.prediction_count,
        probability: parseFloat(h.probability),
        decimalOdds: parseFloat(h.decimal_odds),
        previousProbability: h.previous_probability ? parseFloat(h.previous_probability) : null,
        change: h.probability_change ? parseFloat(h.probability_change) : null
      }))
    });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch odds history' });
  }
});

// Get aggregated analytics for all markets
fastify.get('/api/analytics/summary', async (request, reply) => {
  try {
    const result = await pool.query(`
      WITH latest_snapshots AS (
        SELECT DISTINCT ON (market_id)
          market_id,
          prediction_count,
          probability,
          decimal_odds,
          snapshot_date
        FROM market_snapshots
        WHERE snapshot_type = 'daily'
        ORDER BY market_id, snapshot_date DESC
      )
      SELECT
        m.id,
        m.question,
        m.category,
        m.status,
        ls.prediction_count,
        ls.probability,
        ls.decimal_odds,
        ls.snapshot_date as last_updated
      FROM markets m
      LEFT JOIN latest_snapshots ls ON m.id = ls.market_id
      WHERE m.status = 'open'
      ORDER BY ls.snapshot_date DESC NULLS LAST
    `);

    reply.send({
      markets: result.rows.map(m => ({
        id: m.id,
        question: m.question,
        category: m.category,
        status: m.status,
        predictionCount: m.prediction_count || 0,
        currentOdds: {
          probability: m.probability ? parseFloat(m.probability) : null,
          decimal: m.decimal_odds ? parseFloat(m.decimal_odds) : null
        },
        lastUpdated: m.last_updated
      }))
    });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to fetch analytics summary' });
  }
});

// Trigger snapshot creation (admin only - can be called manually or via cron)
fastify.post('/api/admin/snapshots/create', {
  onRequest: [fastify.requireAdmin]
}, async (request, reply) => {
  const { snapshotType = 'daily', marketId = null } = request.body;

  try {
    let markets;
    
    if (marketId) {
      markets = await pool.query('SELECT id FROM markets WHERE id = $1', [marketId]);
    } else {
      markets = await pool.query('SELECT id FROM markets WHERE status = $1', ['open']);
    }

    let successCount = 0;
    for (const market of markets.rows) {
      try {
        await pool.query(
          'SELECT create_market_snapshot($1, $2)',
          [market.id, snapshotType]
        );
        successCount++;
      } catch (err) {
        fastify.log.error(`Failed to create snapshot for market ${market.id}:`, err);
      }
    }

    reply.send({
      message: `Created ${successCount} snapshots`,
      snapshotType,
      marketsProcessed: markets.rows.length,
      successCount
    });
  } catch (err) {
    fastify.log.error(err);
    reply.code(500).send({ error: 'Failed to create snapshots' });
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

module.exports = fastify;