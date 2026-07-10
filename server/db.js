/*
 * Database + game-file storage layer (Supabase edition).
 *
 *  - Games/likes/comments/recordings live in PostgreSQL (Supabase Database).
 *  - Game HTML files live in Supabase Storage (bucket "games") when
 *    SUPABASE_URL is configured, otherwise on the local filesystem.
 *
 * Required env (see .env.example):
 *   DATABASE_URL          Postgres connection string (Supabase: use the
 *                         "Transaction pooler" URI, port 6543)
 *   SUPABASE_URL          https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_KEY  service_role key — server-side only, never sent
 *                         to the browser (anon key cannot write to Storage)
 */
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5, // Supabase free-tier pooler friendly
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

/* ---------- schema ---------- */
const ready = (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      author     TEXT NOT NULL DEFAULT 'anonymous',
      file       TEXT NOT NULL,
      plays      INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recordings (
      game_id    INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
      seed       INTEGER NOT NULL,
      speed      REAL NOT NULL DEFAULT 2,
      duration   REAL NOT NULL,
      events     TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS likes (
      game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (game_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id         SERIAL PRIMARY KEY,
      game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      name       TEXT NOT NULL DEFAULT '',
      text       TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_game ON comments(game_id, id);
  `);
  console.log('database schema ready');
})();

/* ---------- game file storage ---------- */
const useSupabaseStorage = !!process.env.SUPABASE_URL;
const BUCKET = process.env.SUPABASE_BUCKET || 'games';
const LOCAL_GAMES_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'games');

let supabase = null;
if (useSupabaseStorage) {
  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL is set but SUPABASE_SERVICE_KEY is missing.');
    process.exit(1);
  }
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
} else {
  fs.mkdirSync(LOCAL_GAMES_DIR, { recursive: true });
}

async function saveGameFile(file, html) {
  if (!useSupabaseStorage) {
    await fs.promises.writeFile(path.join(LOCAL_GAMES_DIR, file), html, 'utf8');
    return;
  }
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(file, Buffer.from(html, 'utf8'), { contentType: 'text/html; charset=utf-8', upsert: false });
  if (error) throw new Error('storage upload failed: ' + error.message);
}

async function getGameFile(file) {
  if (!useSupabaseStorage) {
    return fs.promises.readFile(path.join(LOCAL_GAMES_DIR, file), 'utf8');
  }
  const { data, error } = await supabase.storage.from(BUCKET).download(file);
  if (error) { const e = new Error('storage download failed: ' + error.message); e.notFound = true; throw e; }
  return data.text();
}

module.exports = {
  pool,
  ready,
  saveGameFile,
  getGameFile,
  storageMode: useSupabaseStorage ? 'supabase' : 'local',
};
