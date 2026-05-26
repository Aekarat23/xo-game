require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        username VARCHAR(30) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        display_name VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS weekly_stats (
        id SERIAL PRIMARY KEY,
        player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        week_start DATE NOT NULL,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        draws INTEGER DEFAULT 0,
        UNIQUE(player_id, week_start)
      );
    `);

    // Run ALTER / ADD COLUMN as separate queries so failures don't block everything
    const migrations = [
      'ALTER TABLE players ALTER COLUMN password_hash DROP NOT NULL',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS email VARCHAR(255)',
      'ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar_url TEXT',
      'CREATE INDEX IF NOT EXISTS idx_weekly_stats_week ON weekly_stats(week_start)',
      'CREATE INDEX IF NOT EXISTS idx_weekly_stats_wins ON weekly_stats(wins DESC)',
      'CREATE INDEX IF NOT EXISTS idx_players_google_id ON players(google_id)',
    ];

    for (const sql of migrations) {
      try {
        await client.query(sql);
      } catch (err) {
        // Ignore "already exists" / "already nullable" errors
        if (!err.message.includes('already') && !err.message.includes('does not exist')) {
          console.error('Migration warning:', err.message);
        }
      }
    }

    console.log('Database initialized');
  } finally {
    client.release();
  }
}

function getWeekStart() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(d.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

module.exports = { pool, initDB, getWeekStart };
