/* GSNS server — Supabase edition (PostgreSQL + Supabase Storage). */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { pool, ready, saveGameFile, getGameFile, storageMode } = require('./db');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render/most PaaS sit behind one proxy
app.use(express.json({ limit: '4mb' }));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SAMPLES_DIR = path.join(__dirname, '..', 'samples');

const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2MB per game (single HTML file)
const MAX_EVENTS = 30000;
const MAX_RECORDING_MS = 90000;
const REPLAY_SPEED = 2;

/* ---------- helpers ---------- */
const FEED_SELECT = `
  SELECT g.id, g.title, g.author, g.plays, g.created_at,
    (SELECT COUNT(*) FROM likes l WHERE l.game_id = g.id)::int AS likes,
    (SELECT COUNT(*) FROM comments c WHERE c.game_id = g.id)::int AS comments,
    (SELECT COUNT(*) FROM likes l2 WHERE l2.game_id = g.id AND l2.user_id = $1)::int AS liked,
    EXISTS (SELECT 1 FROM recordings r WHERE r.game_id = g.id) AS has_rec,
    (SELECT duration FROM recordings r WHERE r.game_id = g.id) AS rec_duration
  FROM games g`;

function userId(req) {
  const u = String(req.get('x-gsns-user') || '');
  return /^[\w-]{8,64}$/.test(u) ? u : '';
}

function gameId(req) {
  const id = parseInt(req.params.id, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function gameRow(r) {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    plays: r.plays,
    createdAt: Number(r.created_at),
    likes: r.likes,
    comments: r.comments,
    liked: r.liked > 0,
    hasRecording: r.has_rec,
    duration: r.rec_duration || null,
  };
}

// wraps async handlers so rejections become 500s instead of hanging
function h(fn) {
  return (req, res) => fn(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'server error' });
  });
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

// small in-memory cache for game HTML so replays/loops don't hit
// Supabase Storage on every view (keeps free-tier egress low)
const htmlCache = new Map(); // file -> html
function cacheGameHtml(file, html) {
  htmlCache.set(file, html);
  if (htmlCache.size > 50) htmlCache.delete(htmlCache.keys().next().value);
}

/* ---------- API ---------- */
app.get('/api/feed', h(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 8, 1), 20);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const { rows } = await pool.query(
    `${FEED_SELECT} ORDER BY g.id DESC LIMIT $2 OFFSET $3`,
    [userId(req), limit + 1, offset]
  );
  const more = rows.length > limit;
  res.json({
    games: rows.slice(0, limit).map(gameRow),
    nextOffset: more ? offset + limit : null,
  });
}));

app.get('/api/games/:id', h(async (req, res) => {
  const id = gameId(req);
  if (!id) return res.status(404).json({ error: 'not found' });
  const { rows } = await pool.query(`${FEED_SELECT} WHERE g.id = $2`, [userId(req), id]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(gameRow(rows[0]));
}));

app.post('/api/games', h(async (req, res) => {
  if (!allowUpload(req.ip || 'unknown')) return res.status(429).json({ error: 'rate limited' });
  const { title, author, html } = req.body || {};
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 60)
    return res.status(400).json({ error: 'invalid title' });
  if (typeof html !== 'string' || html.length < 20)
    return res.status(400).json({ error: 'invalid html' });
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES)
    return res.status(413).json({ error: 'html too large (max 2MB)' });
  const auth = (typeof author === 'string' && author.trim() ? author.trim() : 'anonymous').slice(0, 30);
  const file = crypto.randomUUID() + '.html';
  await saveGameFile(file, html); // throws on Storage failure → 500, no orphan DB row
  cacheGameHtml(file, html);
  const ins = await pool.query(
    'INSERT INTO games (title, author, file, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [title.trim(), auth, file, Date.now()]
  );
  const { rows } = await pool.query(`${FEED_SELECT} WHERE g.id = $2`, [userId(req), ins.rows[0].id]);
  res.status(201).json(gameRow(rows[0]));
}));

app.post('/api/games/:id/view', h(async (req, res) => {
  const id = gameId(req);
  if (id) await pool.query('UPDATE games SET plays = plays + 1 WHERE id = $1', [id]);
  res.json({ ok: true });
}));

app.get('/api/games/:id/recording', h(async (req, res) => {
  const id = gameId(req);
  if (!id) return res.status(404).json({ error: 'not found' });
  const { rows } = await pool.query(
    'SELECT seed, speed, duration, events FROM recordings WHERE game_id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'no recording yet' });
  const r = rows[0];
  res.json({ seed: r.seed, speed: r.speed, duration: r.duration, events: JSON.parse(r.events) });
}));

// First submitted recording wins; later ones get 409 (unique game_id).
app.post('/api/games/:id/recording', h(async (req, res) => {
  const id = gameId(req);
  if (!id) return res.status(404).json({ error: 'not found' });
  const game = await pool.query('SELECT 1 FROM games WHERE id = $1', [id]);
  if (!game.rows[0]) return res.status(404).json({ error: 'not found' });

  const { seed, duration, events } = req.body || {};
  if (!Number.isFinite(seed)) return res.status(400).json({ error: 'invalid seed' });
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS)
    return res.status(400).json({ error: 'invalid events' });
  const dur = Math.min(Math.max(Number(duration) || 0, 500), MAX_RECORDING_MS + 5000);
  const clean = [];
  for (const e of events) {
    if (!e || !Number.isFinite(e.t) || typeof e.k !== 'string') continue;
    const o = { t: Math.max(0, Math.min(Math.round(e.t), MAX_RECORDING_MS)), k: e.k.slice(0, 16) };
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
    await pool.query(
      'INSERT INTO recordings (game_id, seed, speed, duration, events, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, seed | 0, REPLAY_SPEED, dur, json, Date.now()]
    );
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'already recorded' });
    throw e;
  }
  res.status(201).json({ ok: true });
}));

app.post('/api/games/:id/like', h(async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(400).json({ error: 'missing user id' });
  const id = gameId(req);
  if (!id) return res.status(404).json({ error: 'not found' });
  const del = await pool.query('DELETE FROM likes WHERE game_id = $1 AND user_id = $2', [id, uid]);
  let liked = false;
  if (del.rowCount === 0) {
    const game = await pool.query('SELECT 1 FROM games WHERE id = $1', [id]);
    if (!game.rows[0]) return res.status(404).json({ error: 'not found' });
    await pool.query(
      'INSERT INTO likes (game_id, user_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [id, uid, Date.now()]
    );
    liked = true;
  }
  const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM likes WHERE game_id = $1', [id]);
  res.json({ liked, likes: cnt.rows[0].n });
}));

app.get('/api/games/:id/comments', h(async (req, res) => {
  const id = gameId(req);
  if (!id) return res.status(404).json({ error: 'not found' });
  const { rows } = await pool.query(
    'SELECT id, name, text, created_at FROM comments WHERE game_id = $1 ORDER BY id DESC LIMIT 200', [id]);
  res.json({
    comments: rows.map((c) => ({ id: c.id, name: c.name, text: c.text, createdAt: Number(c.created_at) })),
  });
}));

app.post('/api/games/:id/comments', h(async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(400).json({ error: 'missing user id' });
  const id = gameId(req);
  if (!id) return res.status(404).json({ error: 'not found' });
  const game = await pool.query('SELECT 1 FROM games WHERE id = $1', [id]);
  if (!game.rows[0]) return res.status(404).json({ error: 'not found' });
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'empty comment' });
  const name = String((req.body || {}).name || '').trim().slice(0, 30);
  const ins = await pool.query(
    'INSERT INTO comments (game_id, user_id, name, text, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at',
    [id, uid, name, text, Date.now()]
  );
  res.status(201).json({ id: ins.rows[0].id, name, text, createdAt: Number(ins.rows[0].created_at) });
}));

/* ---------- game page (harness injected, served into a sandboxed iframe) ---------- */
app.get('/game/:id', h(async (req, res) => {
  const id = gameId(req);
  if (!id) return res.status(404).send('not found');
  const { rows } = await pool.query('SELECT file FROM games WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).send('not found');
  const file = rows[0].file;
  let html = htmlCache.get(file);
  if (html === undefined) {
    try {
      html = await getGameFile(file);
    } catch (e) {
      if (e.notFound || e.code === 'ENOENT') return res.status(404).send('not found');
      throw e;
    }
    cacheGameHtml(file, html);
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
}));

app.get('/healthz', (req, res) => res.json({ ok: true, storage: storageMode }));

// static frontend (after API routes)
app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

/* ---------- seed sample games on first boot ---------- */
async function seedSamples() {
  const metaPath = path.join(SAMPLES_DIR, 'meta.json');
  if (!fs.existsSync(metaPath)) return;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  // idempotent: insert samples whose title isn't in the DB yet, and refresh
  // the stored HTML of already-seeded samples when the bundled file changed,
  // so fixes to sample games reach existing deployments too
  const { rows } = await pool.query("SELECT id, title, file FROM games WHERE author = 'GSNS'");
  const have = new Map(rows.map((r) => [r.title, r]));
  let added = 0, updated = 0;
  for (const s of meta) {
    const src = path.join(SAMPLES_DIR, s.file);
    if (!fs.existsSync(src)) continue;
    const html = fs.readFileSync(src, 'utf8');
    const existing = have.get(s.title);
    if (!existing) {
      const file = crypto.randomUUID() + '.html';
      await saveGameFile(file, html);
      await pool.query(
        'INSERT INTO games (title, author, file, created_at) VALUES ($1, $2, $3, $4)',
        [s.title, s.author || 'GSNS', file, Date.now()]
      );
      added++;
      continue;
    }
    let current = null;
    try { current = await getGameFile(existing.file); } catch (e) { /* refetch below overwrites */ }
    if (current === html) continue;
    await saveGameFile(existing.file, html, { overwrite: true });
    // the old recording was captured against the old game code and would
    // replay incorrectly — drop it so the next viewer records a fresh run
    await pool.query('DELETE FROM recordings WHERE game_id = $1', [existing.id]);
    updated++;
  }
  if (added || updated) console.log(`samples: ${added} added, ${updated} updated`);
}

/* ---------- boot: schema first, then seed, then listen ---------- */
const PORT = process.env.PORT || 3000;
ready
  .then(seedSamples)
  .then(() => {
    const server = app.listen(PORT, () =>
      console.log(`GSNS listening on :${PORT} (db: postgres, storage: ${storageMode})`));
    process.on('SIGTERM', () => server.close(() => pool.end().then(() => process.exit(0))));
  })
  .catch((e) => {
    console.error('startup failed:', e);
    process.exit(1);
  });
