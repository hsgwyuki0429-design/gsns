const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { db, GAMES_DIR } = require('./db');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SAMPLES_DIR = path.join(__dirname, '..', 'samples');

const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2MB per game (single HTML file)
const MAX_EVENTS = 30000;
const MAX_RECORDING_MS = 90000;
const REPLAY_SPEED = 2;

// ---------- prepared statements ----------
const q = {
  countGames: db.prepare('SELECT COUNT(*) AS n FROM games'),
  insertGame: db.prepare('INSERT INTO games (title, author, file, created_at) VALUES (?, ?, ?, ?)'),
  getGame: db.prepare('SELECT * FROM games WHERE id = ?'),
  addPlay: db.prepare('UPDATE games SET plays = plays + 1 WHERE id = ?'),
  feed: db.prepare(`
    SELECT g.id, g.title, g.author, g.plays, g.created_at,
      (SELECT COUNT(*) FROM likes l WHERE l.game_id = g.id) AS likes,
      (SELECT COUNT(*) FROM comments c WHERE c.game_id = g.id) AS comments,
      (SELECT COUNT(*) FROM likes l2 WHERE l2.game_id = g.id AND l2.user_id = ?) AS liked,
      (SELECT COUNT(*) FROM recordings r WHERE r.game_id = g.id) AS has_rec,
      (SELECT duration FROM recordings r WHERE r.game_id = g.id) AS rec_duration
    FROM games g ORDER BY g.id DESC LIMIT ? OFFSET ?`),
  feedOne: db.prepare(`
    SELECT g.id, g.title, g.author, g.plays, g.created_at,
      (SELECT COUNT(*) FROM likes l WHERE l.game_id = g.id) AS likes,
      (SELECT COUNT(*) FROM comments c WHERE c.game_id = g.id) AS comments,
      (SELECT COUNT(*) FROM likes l2 WHERE l2.game_id = g.id AND l2.user_id = ?) AS liked,
      (SELECT COUNT(*) FROM recordings r WHERE r.game_id = g.id) AS has_rec,
      (SELECT duration FROM recordings r WHERE r.game_id = g.id) AS rec_duration
    FROM games g WHERE g.id = ?`),
  getRecording: db.prepare('SELECT seed, speed, duration, events FROM recordings WHERE game_id = ?'),
  hasRecording: db.prepare('SELECT 1 FROM recordings WHERE game_id = ?'),
  insertRecording: db.prepare(
    'INSERT INTO recordings (game_id, seed, speed, duration, events, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getLike: db.prepare('SELECT 1 FROM likes WHERE game_id = ? AND user_id = ?'),
  addLike: db.prepare('INSERT OR IGNORE INTO likes (game_id, user_id, created_at) VALUES (?, ?, ?)'),
  delLike: db.prepare('DELETE FROM likes WHERE game_id = ? AND user_id = ?'),
  countLikes: db.prepare('SELECT COUNT(*) AS n FROM likes WHERE game_id = ?'),
  listComments: db.prepare(
    'SELECT id, name, text, created_at FROM comments WHERE game_id = ? ORDER BY id DESC LIMIT 200'
  ),
  addComment: db.prepare(
    'INSERT INTO comments (game_id, user_id, name, text, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
};

// ---------- helpers ----------
function userId(req) {
  const u = String(req.get('x-gsns-user') || '');
  return /^[\w-]{8,64}$/.test(u) ? u : '';
}

function gameRow(r) {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    plays: r.plays,
    createdAt: r.created_at,
    likes: r.likes,
    comments: r.comments,
    liked: !!r.liked,
    hasRecording: !!r.has_rec,
    duration: r.rec_duration || null,
  };
}

// naive per-IP upload rate limit (20/hour)
const uploadLog = new Map();
function allowUpload(ip) {
  const now = Date.now();
  const arr = (uploadLog.get(ip) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= 20) return false;
  arr.push(now);
  uploadLog.set(ip, arr);
  return true;
}

// ---------- API ----------
app.get('/api/feed', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 8, 1), 20);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const rows = q.feed.all(userId(req), limit + 1, offset);
  const more = rows.length > limit;
  res.json({
    games: rows.slice(0, limit).map(gameRow),
    nextOffset: more ? offset + limit : null,
  });
});

app.get('/api/games/:id', (req, res) => {
  const row = q.feedOne.get(userId(req), req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(gameRow(row));
});

app.post('/api/games', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!allowUpload(ip)) return res.status(429).json({ error: 'rate limited' });
  const { title, author, html } = req.body || {};
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 60)
    return res.status(400).json({ error: 'invalid title' });
  if (typeof html !== 'string' || html.length < 20)
    return res.status(400).json({ error: 'invalid html' });
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES)
    return res.status(413).json({ error: 'html too large (max 2MB)' });
  const auth = (typeof author === 'string' && author.trim() ? author.trim() : 'anonymous').slice(0, 30);
  const file = crypto.randomUUID() + '.html';
  fs.writeFileSync(path.join(GAMES_DIR, file), html, 'utf8');
  const info = q.insertGame.run(title.trim(), auth, file, Date.now());
  const row = q.feedOne.get(userId(req), info.lastInsertRowid);
  res.status(201).json(gameRow(row));
});

app.post('/api/games/:id/view', (req, res) => {
  q.addPlay.run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/games/:id/recording', (req, res) => {
  const r = q.getRecording.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'no recording yet' });
  res.json({ seed: r.seed, speed: r.speed, duration: r.duration, events: JSON.parse(r.events) });
});

// First submitted recording wins; later ones get 409.
app.post('/api/games/:id/recording', (req, res) => {
  const g = q.getGame.get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  if (q.hasRecording.get(g.id)) return res.status(409).json({ error: 'already recorded' });

  const { seed, duration, events } = req.body || {};
  if (!Number.isFinite(seed)) return res.status(400).json({ error: 'invalid seed' });
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS)
    return res.status(400).json({ error: 'invalid events' });
  const dur = Math.min(Math.max(Number(duration) || 0, 500), MAX_RECORDING_MS + 5000);
  const clean = [];
  for (const e of events) {
    if (!e || !Number.isFinite(e.t) || typeof e.k !== 'string') continue;
    const t = Math.max(0, Math.min(Math.round(e.t), MAX_RECORDING_MS));
    const o = { t, k: e.k.slice(0, 16) };
    if (Number.isFinite(e.x)) o.x = Math.max(0, Math.min(+e.x, 1));
    if (Number.isFinite(e.y)) o.y = Math.max(0, Math.min(+e.y, 1));
    if (Number.isFinite(e.b)) o.b = e.b | 0;
    if (typeof e.key === 'string') o.key = e.key.slice(0, 24);
    if (typeof e.c === 'string') o.c = e.c.slice(0, 24);
    clean.push(o);
  }
  if (!clean.length) return res.status(400).json({ error: 'invalid events' });
  clean.sort((a, b) => a.t - b.t);
  const json = JSON.stringify(clean);
  if (json.length > 3 * 1024 * 1024) return res.status(413).json({ error: 'recording too large' });
  try {
    q.insertRecording.run(g.id, seed | 0, REPLAY_SPEED, dur, json, Date.now());
  } catch (e) {
    return res.status(409).json({ error: 'already recorded' });
  }
  res.status(201).json({ ok: true });
});

app.post('/api/games/:id/like', (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(400).json({ error: 'missing user id' });
  const g = q.getGame.get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  let liked;
  if (q.getLike.get(g.id, uid)) {
    q.delLike.run(g.id, uid);
    liked = false;
  } else {
    q.addLike.run(g.id, uid, Date.now());
    liked = true;
  }
  res.json({ liked, likes: q.countLikes.get(g.id).n });
});

app.get('/api/games/:id/comments', (req, res) => {
  res.json({
    comments: q.listComments.all(req.params.id).map((c) => ({
      id: c.id,
      name: c.name,
      text: c.text,
      createdAt: c.created_at,
    })),
  });
});

app.post('/api/games/:id/comments', (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(400).json({ error: 'missing user id' });
  const g = q.getGame.get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'empty comment' });
  const name = String((req.body || {}).name || '').trim().slice(0, 30);
  const info = q.addComment.run(g.id, uid, name, text, Date.now());
  res.status(201).json({ id: info.lastInsertRowid, name, text, createdAt: Date.now() });
});

// ---------- game page (harness injected, served into a sandboxed iframe) ----------
app.get('/game/:id', (req, res) => {
  const g = q.getGame.get(req.params.id);
  if (!g) return res.status(404).send('not found');
  let html;
  try {
    html = fs.readFileSync(path.join(GAMES_DIR, g.file), 'utf8');
  } catch (e) {
    return res.status(404).send('not found');
  }
  const mode = req.query.mode === 'replay' ? 'replay' : 'record';
  const seed = (parseInt(req.query.seed) || 1) | 0;
  const speed = Math.min(Math.max(parseFloat(req.query.speed) || REPLAY_SPEED, 0.25), 8);
  const inject =
    `<script>window.__GSNS__=${JSON.stringify({ mode, seed, speed })};</script>` +
    `<script src="/harness.js"></script>`;
  // The harness must run before any game code: inject right after <head>, or prepend.
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => m + inject);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html[^>]*>/i, (m) => m + inject);
  } else {
    html = inject + html;
  }
  res.set('Cache-Control', 'private, max-age=120');
  res.type('html').send(html);
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// static frontend (after API routes)
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));
// SPA-ish fallback: deep links like /?g=123 use query params, so only / needs serving.

// ---------- seed sample games on first boot ----------
function seedSamples() {
  if (q.countGames.get().n > 0) return;
  const metaPath = path.join(SAMPLES_DIR, 'meta.json');
  if (!fs.existsSync(metaPath)) return;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  for (const s of meta) {
    const src = path.join(SAMPLES_DIR, s.file);
    if (!fs.existsSync(src)) continue;
    const file = crypto.randomUUID() + '.html';
    fs.copyFileSync(src, path.join(GAMES_DIR, file));
    q.insertGame.run(s.title, s.author || 'GSNS', file, Date.now());
  }
  console.log(`seeded ${meta.length} sample games`);
}
seedSamples();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GSNS listening on :${PORT}`));
