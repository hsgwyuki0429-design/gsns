const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

// PostgreSQL接続（Supabase）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabaseはhttps必須
});

// ゲームファイルの保存先：環境変数で LocalFS or Supabase を選択
const STORAGE_MODE = process.env.STORAGE_MODE || 'local'; // 'local' or 'supabase'
const LOCAL_GAMES_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'games') : path.join(__dirname, '..', 'data', 'games');
if (STORAGE_MODE === 'local') fs.mkdirSync(LOCAL_GAMES_DIR, { recursive: true });

// テーブル作成（初回接続時に自動実行）
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS games (
        id         SERIAL PRIMARY KEY,
        title      VARCHAR(255) NOT NULL,
        author     VARCHAR(255) NOT NULL DEFAULT 'anonymous',
        file       VARCHAR(255) NOT NULL,
        plays      INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recordings (
        game_id    INTEGER PRIMARY KEY REFERENCES games(id),
        seed       INTEGER NOT NULL,
        speed      FLOAT NOT NULL DEFAULT 2,
        duration   FLOAT NOT NULL,
        events     TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS likes (
        game_id INTEGER NOT NULL REFERENCES games(id),
        user_id VARCHAR(255) NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (game_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id         SERIAL PRIMARY KEY,
        game_id    INTEGER NOT NULL REFERENCES games(id),
        user_id    VARCHAR(255) NOT NULL,
        name       VARCHAR(255) NOT NULL DEFAULT '',
        text       TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comments_game ON comments(game_id, id);
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}
initDb().catch(console.error);

// ゲームファイルの保存/取得ヘルパー
async function saveGameFile(file, html) {
  if (STORAGE_MODE === 'local') {
    fs.writeFileSync(path.join(LOCAL_GAMES_DIR, file), html, 'utf8');
  } else {
    // Supabase Storage へアップロード
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    await supabase.storage.from('games').upload(file, Buffer.from(html), { upsert: true });
  }
}

async function getGameFile(file) {
  if (STORAGE_MODE === 'local') {
    return fs.readFileSync(path.join(LOCAL_GAMES_DIR, file), 'utf8');
  } else {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data, error } = await supabase.storage.from('games').download(file);
    if (error) throw new Error('File not found: ' + file);
    return data.text();
  }
}

module.exports = {
  db: pool,
  saveGameFile,
  getGameFile,
  LOCAL_GAMES_DIR,
  STORAGE_MODE,
};
