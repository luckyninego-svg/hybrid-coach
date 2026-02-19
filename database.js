/**
 * DATABASE LAYER
 * Uses SQLite for simplicity — swap for Supabase/PostgreSQL when scaling
 * 
 * To use Supabase instead:
 * 1. npm install @supabase/supabase-js
 * 2. Replace all db calls with Supabase client calls
 * 3. Same table structure applies
 */

const Database = require('better-sqlite3');
const path = require('path');

let db;

function init() {
  db = new Database(path.join(__dirname, 'coach.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS athletes (
      telegram_id       TEXT PRIMARY KEY,
      name              TEXT,
      strava_id         TEXT,
      strava_connected  INTEGER DEFAULT 0,
      strava_access_token   TEXT,
      strava_refresh_token  TEXT,
      strava_token_expires  INTEGER,
      five_k_time       TEXT,
      critical_speed    TEXT,
      zone1_pace        TEXT,
      zone2_pace        TEXT,
      zone3_pace        TEXT,
      zone4_pace        TEXT,
      zone5_pace        TEXT,
      training_phase    TEXT DEFAULT 'Base',
      goal_race         TEXT,
      experience        TEXT,
      awaiting_input    TEXT,
      created_at        TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activities (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id     TEXT,
      strava_id       TEXT UNIQUE,
      type            TEXT,
      name            TEXT,
      date            TEXT,
      distance_km     REAL,
      duration_min    INTEGER,
      avg_pace        TEXT,
      avg_hr          REAL,
      max_hr          REAL,
      suffer_score    REAL,
      elevation_m     REAL,
      raw_data        TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (telegram_id) REFERENCES athletes(telegram_id)
    );

    CREATE INDEX IF NOT EXISTS idx_activities_telegram ON activities(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_athletes_strava ON athletes(strava_id);
  `);

  console.log('✅ Database initialized');
}

function upsertAthlete(data) {
  const stmt = db.prepare(`
    INSERT INTO athletes (telegram_id, name)
    VALUES (@telegram_id, @name)
    ON CONFLICT(telegram_id) DO UPDATE SET
      name = COALESCE(excluded.name, athletes.name)
  `);
  return stmt.run(data);
}

function updateAthlete(telegramId, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = @${k}`).join(', ');
  const stmt = db.prepare(`UPDATE athletes SET ${sets} WHERE telegram_id = @telegram_id`);
  return stmt.run({ ...fields, telegram_id: String(telegramId) });
}

function getAthleteByTelegram(telegramId) {
  return db.prepare('SELECT * FROM athletes WHERE telegram_id = ?').get(String(telegramId));
}

function getAthleteByStravaId(stravaId) {
  return db.prepare('SELECT * FROM athletes WHERE strava_id = ?').get(String(stravaId));
}

function saveActivity(data) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO activities 
      (telegram_id, strava_id, type, name, date, distance_km, duration_min, 
       avg_pace, avg_hr, max_hr, suffer_score, elevation_m, raw_data)
    VALUES 
      (@telegram_id, @strava_id, @type, @name, @date, @distance_km, @duration_min,
       @avg_pace, @avg_hr, @max_hr, @suffer_score, @elevation_m, @raw_data)
  `);
  return stmt.run(data);
}

function getRecentActivities(telegramId, limit = 7) {
  return db.prepare(`
    SELECT * FROM activities 
    WHERE telegram_id = ? 
    ORDER BY date DESC 
    LIMIT ?
  `).all(String(telegramId), limit);
}

module.exports = {
  init,
  upsertAthlete,
  updateAthlete,
  getAthleteByTelegram,
  getAthleteByStravaId,
  saveActivity,
  getRecentActivities
};
