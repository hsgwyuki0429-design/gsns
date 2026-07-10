const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const GAMES_DIR = path.join(DATA_DIR, 'games');
fs.mkdirSync(GAMES_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'gsns.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS games (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT 'anonymous',
  file       TEXT NOT NULL,
  plays      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recordings (
  game_id    INTEGER PRIMARY KEY REFERENCES games(id),
  seed       INTEGER NOT NULL,
  speed      REAL NOT NULL DEFAULT 2,
  duration   REAL NOT NULL,
  events     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  game_id INTEGER NOT NULL REFERENCES games(id),
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL REFERENCES games(id),
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_game ON comments(game_id, id);
`);

module.exports = { db, DATA_DIR, GAMES_DIR };
