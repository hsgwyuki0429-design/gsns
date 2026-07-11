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

// --- TEMP connection diagnostics: masked, prints NO secrets --------------
// Helps locate a bad DATABASE_URL (hidden whitespace, stray brackets/quotes,
// wrong host/user). Remove once the deploy connects successfully.
(() => {
  const raw = process.env.DATABASE_URL;
  console.log('[db-diag] DATABASE_URL rawLength=%d trimmedDiffers=%s',
    raw.length, String(raw !== raw.trim()));
  try {
    const u = new URL(raw);
    const pw = u.password || '';
    let decoded = pw;
    try { decoded = decodeURIComponent(pw); } catch (_) { /* keep raw */ }
    const alnum = (c) => /^[A-Za-z0-9]$/.test(c);
    console.log('[db-diag] host=%s port=%s user=%s db=%s',
      u.hostname, u.port, u.username, u.pathname.replace(/^\//, ''));
    console.log('[db-diag] passwordLength=%d hasWhitespace=%s hasNonAlnum=%s firstIsAlnum=%s lastIsAlnum=%s',
      decoded.length,
      String(/\s/.test(decoded)),
      String(/[^A-Za-z0-9]/.test(decoded)),
      String(alnum(decoded.slice(0, 1))),
      String(alnum(decoded.slice(-1))));
  } catch (e) {
    console.log('[db-diag] URL parse failed:', e.message);
  }
})();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5, // Supabase free-tier pooler friendly
  connectionTimeoutMillis: 10000, // fail fast while the db is paused/unreachable
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

/* ---------- schema ---------- */
// Retries forever instead of failing: a paused Supabase project (free tier
// pauses after a week of inactivity) or a transient outage must not take
// the site down — APIs return 500 until the database comes back.
const ready = (async () => {
  for (let delay = 2000; ; delay = Math.min(delay * 2, 60000)) {
    try {
      await initSchema();
      console.log('database schema ready');
      return;
    } catch (e) {
      console.error(`schema init failed (retrying in ${delay}ms):`, e.message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
})();

async function initSchema() {
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
}

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

async function saveGameFile(file, html, opts) {
  const overwrite = !!(opts && opts.overwrite);
  if (!useSupabaseStorage) {
    await fs.promises.writeFile(path.join(LOCAL_GAMES_DIR, file), html, 'utf8');
    return;
  }
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(file, Buffer.from(html, 'utf8'), { contentType: 'text/html; charset=utf-8', upsert: overwrite });
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
