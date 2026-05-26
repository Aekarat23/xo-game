require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { pool, getWeekStart } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'xo-game-secret-key-2025';
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function authRoutes(app) {
  // Register
  app.post('/api/register', async (req, res) => {
    try {
      const { username, password, display_name } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
      }
      if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: 'ชื่อผู้ใช้ต้อง 3-30 ตัวอักษร' });
      }
      if (password.length < 4) {
        return res.status(400).json({ error: 'รหัสผ่านต้องอย่างน้อย 4 ตัวอักษร' });
      }

      const hash = await bcrypt.hash(password, 10);
      const result = await pool.query(
        'INSERT INTO players (username, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, username, display_name, avatar_url, email',
        [username.toLowerCase(), hash, display_name || username]
      );

      const player = result.rows[0];
      const token = jwt.sign({ id: player.id, username: player.username, displayName: player.display_name, avatarUrl: player.avatar_url }, JWT_SECRET);
      res.json({ token, player: { id: player.id, username: player.username, display_name: player.display_name, avatar_url: player.avatar_url, email: player.email } });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(400).json({ error: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });
      }
      console.error(err);
      res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
    }
  });

  // Login
  app.post('/api/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
      }

      const result = await pool.query(
        'SELECT * FROM players WHERE username = $1',
        [username.toLowerCase()]
      );
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
      }

      const player = result.rows[0];
      if (!player.password_hash) {
        return res.status(401).json({ error: 'บัญชีนี้ใช้ Google Sign-In กรุณาเข้าสู่ระบบด้วย Google' });
      }
      const valid = await bcrypt.compare(password, player.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
      }

      const token = jwt.sign({ id: player.id, username: player.username, displayName: player.display_name, avatarUrl: player.avatar_url }, JWT_SECRET);
      res.json({ token, player: { id: player.id, username: player.username, display_name: player.display_name, avatar_url: player.avatar_url, email: player.email } });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
    }
  });

  // Google OAuth Login
  app.post('/api/google-login', async (req, res) => {
    try {
      const { credential } = req.body;
      if (!credential) {
        return res.status(400).json({ error: 'ไม่ได้รับข้อมูล Google' });
      }

      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      const googleId = payload.sub;
      const email = payload.email;
      const displayName = payload.name;
      const avatarUrl = payload.picture;

      // Check if user exists by google_id
      let result = await pool.query(
        'SELECT id, username, display_name, avatar_url, email FROM players WHERE google_id = $1',
        [googleId]
      );

      if (result.rows.length === 0) {
        // Check by email (link to existing account)
        result = await pool.query(
          'SELECT id FROM players WHERE email = $1',
          [email]
        );
        if (result.rows.length > 0) {
          // Link Google ID to existing account
          result = await pool.query(
            'UPDATE players SET google_id = $1, avatar_url = COALESCE(avatar_url, $2), display_name = COALESCE(NULLIF(display_name, \'\'), $3) WHERE id = $4 RETURNING id, username, display_name, avatar_url, email',
            [googleId, avatarUrl, displayName, result.rows[0].id]
          );
        } else {
          // Create new account
          const username = 'g_' + googleId.substring(0, 12);
          try {
            result = await pool.query(
              'INSERT INTO players (username, password_hash, display_name, google_id, email, avatar_url) VALUES ($1, NULL, $2, $3, $4, $5) RETURNING id, username, display_name, avatar_url, email',
              [username, displayName, googleId, email, avatarUrl]
            );
          } catch (insertErr) {
            if (insertErr.code === '23505') {
              // Username collision — use full google_id
              const fullUsername = 'g_' + googleId;
              result = await pool.query(
                'INSERT INTO players (username, password_hash, display_name, google_id, email, avatar_url) VALUES ($1, NULL, $2, $3, $4, $5) RETURNING id, username, display_name, avatar_url, email',
                [fullUsername, displayName, googleId, email, avatarUrl]
              );
            } else {
              throw insertErr;
            }
          }
        }
      }

      const player = result.rows[0];
      const token = jwt.sign({ id: player.id, username: player.username, displayName: player.display_name, avatarUrl: player.avatar_url }, JWT_SECRET);
      res.json({
        token,
        player: {
          id: player.id,
          username: player.username,
          display_name: player.display_name || player.username,
          avatar_url: player.avatar_url,
          email: player.email
        }
      });
    } catch (err) {
      console.error('Google login error:', err.message || err);
      res.status(401).json({ error: 'Google login ไม่สำเร็จ' });
    }
  });

  // Get profile with stats
  app.get('/api/profile', async (req, res) => {
    try {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
      }
      const token = auth.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      const playerResult = await pool.query(
        'SELECT id, username, display_name, avatar_url, email, created_at FROM players WHERE id = $1',
        [decoded.id]
      );
      if (playerResult.rows.length === 0) {
        return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
      }

      const weekStart = getWeekStart();
      const statsResult = await pool.query(
        'SELECT wins, losses, draws FROM weekly_stats WHERE player_id = $1 AND week_start = $2',
        [decoded.id, weekStart]
      );

      const stats = statsResult.rows[0] || { wins: 0, losses: 0, draws: 0 };
      res.json({ player: playerResult.rows[0], stats });
    } catch (err) {
      res.status(401).json({ error: 'Token ไม่ถูกต้อง' });
    }
  });

  // Update profile
  app.put('/api/profile', async (req, res) => {
    try {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
      }
      const token = auth.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      const { display_name, avatar_url } = req.body;
      const updates = [];
      const values = [];
      let paramIdx = 1;

      if (display_name !== undefined) {
        if (display_name.length > 50) {
          return res.status(400).json({ error: 'ชื่อที่แสดงต้องไม่เกิน 50 ตัวอักษร' });
        }
        updates.push(`display_name = $${paramIdx++}`);
        values.push(display_name);
      }
      if (avatar_url !== undefined) {
        updates.push(`avatar_url = $${paramIdx++}`);
        values.push(avatar_url);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'ไม่มีข้อมูลที่จะอัปเดต' });
      }

      values.push(decoded.id);
      const result = await pool.query(
        `UPDATE players SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING id, username, display_name, avatar_url, email`,
        values
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
      }

      const player = result.rows[0];
      const weekStart = getWeekStart();
      const statsResult = await pool.query(
        'SELECT wins, losses, draws FROM weekly_stats WHERE player_id = $1 AND week_start = $2',
        [decoded.id, weekStart]
      );
      const stats = statsResult.rows[0] || { wins: 0, losses: 0, draws: 0 };

      res.json({
        player: { id: player.id, username: player.username, display_name: player.display_name, avatar_url: player.avatar_url, email: player.email },
        stats
      });
    } catch (err) {
      console.error('Update profile error:', err);
      res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
    }
  });

  // Leaderboard
  app.get('/api/leaderboard', async (req, res) => {
    try {
      const weekStart = getWeekStart();
      const result = await pool.query(`
        SELECT p.id, p.username, p.display_name, p.avatar_url,
               COALESCE(s.wins, 0) as wins,
               COALESCE(s.losses, 0) as losses,
               COALESCE(s.draws, 0) as draws,
               COALESCE(s.wins, 0) * 3 + COALESCE(s.draws, 0) * 1 as points
        FROM players p
        LEFT JOIN weekly_stats s ON s.player_id = p.id AND s.week_start = $1
        WHERE s.wins > 0 OR s.losses > 0 OR s.draws > 0
        ORDER BY points DESC, wins DESC
        LIMIT 50
      `, [weekStart]);

      const allTimeResult = await pool.query(`
        SELECT p.id, p.username, p.display_name, p.avatar_url,
               SUM(COALESCE(s.wins, 0)) as total_wins,
               SUM(COALESCE(s.losses, 0)) as total_losses,
               SUM(COALESCE(s.draws, 0)) as total_draws,
               SUM(COALESCE(s.wins, 0)) * 3 + SUM(COALESCE(s.draws, 0)) * 1 as total_points
        FROM players p
        LEFT JOIN weekly_stats s ON s.player_id = p.id
        GROUP BY p.id, p.username, p.display_name, p.avatar_url
        HAVING SUM(COALESCE(s.wins, 0)) > 0
        ORDER BY total_points DESC, total_wins DESC
        LIMIT 50
      `);

      res.json({
        weekly: result.rows,
        allTime: allTimeResult.rows,
        weekStart
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
    }
  });
}

// Record game result
async function recordGameResult(playerId, result) {
  try {
    const weekStart = getWeekStart();
    await pool.query(`
      INSERT INTO weekly_stats (player_id, week_start, wins, losses, draws)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (player_id, week_start)
      DO UPDATE SET
        wins = weekly_stats.wins + $3,
        losses = weekly_stats.losses + $4,
        draws = weekly_stats.draws + $5
    `, [playerId, weekStart,
      result === 'win' ? 1 : 0,
      result === 'lose' ? 1 : 0,
      result === 'draw' ? 1 : 0
    ]);
  } catch (err) {
    console.error('recordGameResult error:', err);
  }
}

// Middleware to verify token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

module.exports = { authRoutes, recordGameResult, verifyToken };
