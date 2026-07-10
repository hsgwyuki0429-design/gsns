/* GSNS server — Supabase版（PostgreSQL + Cloud Storage）*/
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, saveGameFile, getGameFile, STORAGE_MODE } = require('./db');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SAMPLES_DIR = path.join(__dirname, '..', 'samples');

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 30000;
const MAX_RECORDING_MS = 90000;
const REPLAY_SPEED = 2;

// ========== 非同期クエリヘルパー ==========
async function dbQuery(sql, params = []) {
  const res = await db.query(sql, params);
  return res.rows;
}

async function dbQueryOne(sql, params = []) {
  const res = await db.query(sql, params);
  return res.rows[0] || null;
}

// ========== API ルート ==========

app.get('/api/feed', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 8, 1), 20);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const userId = String(req.get('x-gsns-user') || '').slice(0, 64);

  try {
    const rows = await dbQuery(`
      SELECT g.id, g.title, g.author, g.plays, g.created_at,
        (SELECT COUNT(*) FROM likes l WHERE l.game_id = g.id)::INTEGER AS likes,
        (SELECT COUNT(*) FROM comments c WHERE c.game_id = g.id)::INTEGER AS comments,
        (SELECT COUNT(*) FROM likes l2 WHERE l2.game_id = g.id AND l2.user_id = $1)::INTEGER AS liked,
        (SELECT COUNT(*) FROM recordings r WHERE r.game_id = g.id)::INTEGER AS has_rec,
        (SELECT duration FROM recordings r WHERE r.game_id = g.id) AS rec_duration
      FROM games g ORDER BY g.id DESC LIMIT $2 OFFSET $3
    `, [userId, limit + 1, offset]);

    const more = rows.length > limit;
    res.json({
      games: rows.slice(0, limit).map(gameRow),
      nextOffset: more ? offset + limit : null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'database error' });
  }
});

app.get('/api/games/:id', async (req, res) => {
  const userId = String(req.get('x-gsns-user') || '').slice(0, 64);
  try {
    const row = await dbQueryOne(`
      SELECT g.id, g.title, g.author, g.plays, g.created_at,
        (SELECT COUNT(*) FROM likes l WHERE l.game_id = g.id)::INTEGER AS likes,
        (SELECT COUNT(*) FROM comments c WHERE c.game_id = g.id)::INTEGER AS comments,
        (SELECT COUNT(*) FROM likes l2 WHERE l2.game_id = g.id AND l2.user_id = $1)::INTEGER AS liked,
        (SELECT COUNT(*) FROM recordings r WHERE r.game_id = g.id)::INTEGER AS has_rec,
        (SELECT duration FROM recordings r WHERE r.game_id = g.id) AS rec_duration
      FROM games g WHERE g.id = $2
    `, [userId, req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(gameRow(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'database error' });
  }
});

app.post('/api/games', async (req, res) => {
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

  try {
    await saveGameFile(file, html);
    const userId = String(req.get('x-gsns-user') || '').slice(0, 64);
    const game = await dbQueryOne(
      'INSERT INTO games (title, author, file, created_at) VALUES ($1, $2, $3, $4) RETURNING *',
      [title.trim(), auth, file, Date.now()]
    );
    const row = await dbQueryOne(`
      SELECT g.id, g.title, g.author, g.plays, g.created_at,
        (SELECT COUNT(*) FROM likes l WHERE l.game_id = g.id)::INTEGER AS likes,
        (SELECT COUNT(*) FROM comments c WHERE c.game_id = g.id)::INTEGER AS comments,
        (SELECT COUNT(*) FROM likes l2 WHERE l2.game_id = g.id AND l2.user_id = $1)::INTEGER AS liked,
        (SELECT COUNT(*) FROM recordings r WHERE r.game_id = g.id)::INTEGER AS has_rec,
        (SELECT duration FROM recordings r WHERE r.game_id = g.id) AS rec_duration
      FROM games g WHERE g.id = $2
    `, [userId, game.id]);
    res.status(201).json(gameRow(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'upload failed' });
  }
});

app.post('/api/games/:id/view', async (req, res) => {
  try {
    await db.query('UPDATE games SET plays = plays + 1 WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'database error' });
  }
});

app.get('/api/games/:id/recording', async (req, res) => {
  try {
    const r = await dbQueryOne('SELECT seed, speed, duration, events FROM recordings WHERE game_id = $1', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'no recording yet' });
    res.json({ seed: r.seed, speed: r.speed, duration: r.duration, events: JSON.parse(r.events) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'database error' });
  }
});

app.post('/api/games/:id/recording', async (req, res) => {
  const { seed, duration, events } = req.body || {};
  if (!Number.isFinite(seed) || !Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS)
    return res.status(400).json({ error: 'invalid request' });

  try {
    const existing = await dbQueryOne('SELECT 1 FROM recordings WHERE game_id = $1', [req.params.id]);
    if (existing) return res.status(409).json({ error: 'already recorded' });

    const dur = Math.min(Math.max(Number(duration) || 0, 500), MAX_RECORDING_MS + 5000);
    const clean = events.filter((e) => e && Number.isFinite(e.t) && typeof e.k === 'string').map((e) => ({
      t: Math.max(0, Math.min(Math.round(e.t), MAX_RECORDING_MS)),
      k: e.k.slice(0, 16),
      ...(Number.isFinite(e.x) && { x: Math.max(0, Math.min(+e.x, 1)) }),
      ...(Number.isFinite(e.y) && { y: Math.max(0, Math.min(+e.y, 1)) }),
      ...(Number.isFinite(e.b) && { b: e.b | 0 }),
      ...(typeof e.key === 'string' && { key: e.key.slice(0, 24) }),
      ...(typeof e.c === 'string' && { c: e.c.slice(0, 24) }),
    }));
    if (!clean.length) return res.status(400).json({ error: 'invalid events' });
    clean.sort((a, b) => a.t - b.t);
    const json = JSON.stringify(clean);
    if (json.length > 3 * 1024 * 1024) return res.status(413).json({ error: 'recording too large' });

    await db.query(
      'INSERT INTO recordings (game_id, seed, speed, duration, events, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.params.id, seed | 0, REPLAY_SPEED, dur, json, Date.now()]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    if (e.code === '23505') return res.status(409).json({ error: 'already recorded' }); // unique violation
    res.status(500).json({ error: 'database error' });
  }
});

app.post('/api/games/:id/like', async (req, res) => {
  const uid = String(req.get('x-gsns-user') || '').slice(0, 64);
  if (!uid) return res.status(400).json({ error: 'missing user id' });

  try {
    const existing = await dbQueryOne('SELECT 1 FROM likes WHERE game_id = $1 AND user_id = $2', [req.params.id, uid]);
    let liked;
    if (existing) {
      await db.query('DELETE FROM likes WHERE game_id = $1 AND user_id = $2', [req.params.id, uid]);
      liked = false;
    } else {
      await db.query('INSERT INTO likes (game_id, user_id, created_at) VALUES ($1, $2, $3)', [req.params.id, uid, Date.now()]);
      liked = true;
    }
    const count = await dbQueryOne('SELECT COUNT(*) AS n FROM likes WHERE game_id = $1', [req.params.id]);
    res.json({ liked, likes: count.n });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'database error' });
  }
});

app.get('/api/games/:id/comments', async (req, res) => {
  try {
    const comments = await dbQuery(
      'SELECT id, name, text, created_at FROM comments WHERE game_id = $1 ORDER BY id DESC LIMIT 200',
      [req.params.id]
    );
    res.json({ comments: comments.map((c) => ({ id: c.id, name: c.name, text: c.text, createdAt: c.created_at })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'database error' });
  }
});

app.post('/api/games/:id/comments', async (req, res) => {
  const uid = String(req.get('x-gsns-user') || '').slice(0, 64);
  if (!uid) return res.status(400).json({ error: 'missing user id' });
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'empty comment' });
  const name = String((req.body || {}).name || '').trim().slice(0, 30);

  try {
    const c = await dbQueryOne(
      'INSERT INTO comments (game_id, user_id, name, text, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, text, created_at',
      [req.params.id, uid, name, text, Date.now()]
    );
    res.status(201).json({ id: c.id, name: c.name, text: c.text, createdAt: c.created_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'database error' });
  }
});

app.get('/game/:id', async (req, res) => {
  try {
    const g = await dbQueryOne('SELECT * FROM games WHERE id = $1', [req.params.id]);
    if (!g) return res.status(404).send('not found');
    let html = await getGameFile(g.file);
    const mode = req.query.mode === 'replay' ? 'replay' : 'record';
    const seed = (parseInt(req.query.seed) || 1) | 0;
    const speed = Math.min(Math.max(parseFloat(req.query.speed) || REPLAY_SPEED, 0.25), 8);
    const inject = `<script>window.__GSNS__=${JSON.stringify({ mode, seed, speed })};</script><script src="/harness.js"><\/script>`;
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m) => m + inject);
    } else if (/<html[^>]*>/i.test(html)) {
      html = html.replace(/<html[^>]*>/i, (m) => m + inject);
    } else {
      html = inject + html;
    }
    res.set('Cache-Control', 'private, max-age=120');
    res.type('html').send(html);
  } catch (e) {
    console.error(e);
    res.status(404).send('not found');
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true, storage: STORAGE_MODE }));
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

// ========== ヘルパー関数 ==========

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

const uploadLog = new Map();
function allowUpload(ip) {
  const now = Date.now();
  const arr = (uploadLog.get(ip) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= 20) return false;
  arr.push(now);
  uploadLog.set(ip, arr);
  return true;
}

// ========== サンプルゲーム自動投入 ==========

async function seedSamples() {
  const count = await dbQueryOne('SELECT COUNT(*) AS n FROM games');
  if (count.n > 0) return;
  const metaPath = path.join(SAMPLES_DIR, 'meta.json');
  if (!require('fs').existsSync(metaPath)) return;
  const meta = JSON.parse(require('fs').readFileSync(metaPath, 'utf8'));
  for (const s of meta) {
    const src = path.join(SAMPLES_DIR, s.file);
    if (!require('fs').existsSync(src)) continue;
    const file = crypto.randomUUID() + '.html';
    const html = require('fs').readFileSync(src, 'utf8');
    await saveGameFile(file, html);
    await db.query(
      'INSERT INTO games (title, author, file, created_at) VALUES ($1, $2, $3, $4)',
      [s.title, s.author || 'GSNS', file, Date.now()]
    );
  }
  console.log(`seeded ${meta.length} sample games`);
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  await seedSamples();
  console.log(`GSNS listening on :${PORT} (storage: ${STORAGE_MODE})`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    db.end(() => process.exit(0));
  });
});
