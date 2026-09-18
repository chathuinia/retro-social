// server.js — соцсеть + форумы + группы + поиск + истории + профиль + стикеры + звонки + игры + защита
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// === ЗАГОЛОВКИ БЕЗОПАСНОСТИ ===
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "img-src 'self' data: https: http: blob:; " +
    "media-src 'self' data: https: http: blob:; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.socket.io https://scratch.mit.edu; " +
    "style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' ws: wss:; " +
    "frame-src https://www.youtube.com https://vk.com https://scratch.mit.edu; " +
    "object-src 'self'; " +
    "base-uri 'self'; " +
    "form-action 'self';"
  );
  next();
});

// ============================================================
// ВСТАВЬТЕ СВОЮ СТРОКУ ИЗ NEON НИЖЕ (без ?sslmode=require)
// ============================================================
const HARDCODED_DB_URL = 'postgresql://neondb_owner:npg_yOQcIwub8V6N@ep-solitary-rain-a5orxtnv-pooler.us-east-2.aws.neon.tech/neondb';
const HARDCODED_JWT_SECRET = 'retro2010secret123';
const OWNER_USERNAME = 'lol';
// ============================================================

const JWT_SECRET = process.env.JWT_SECRET || HARDCODED_JWT_SECRET || 'retro-2010-secret';

let dbUrl = process.env.DATABASE_URL || HARDCODED_DB_URL || '';
dbUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]channel_binding=[^&]*/g, '').replace(/\?$/, '').trim();

console.log('=== DB CONFIG ===');
console.log('Источник DATABASE_URL:', process.env.DATABASE_URL ? 'ENV' : 'HARDCODED');
console.log('Длина строки:', dbUrl.length);
console.log('Владелец:', OWNER_USERNAME);

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 5
});

pool.on('error', (err) => console.error('POOL ERROR:', err.message));

// ============================================================
// ЗАЩИТА ОТ XSS / SVG
// ============================================================
function containsForbidden(str) {
  if (!str) return false;
  const s = String(str);
  return /<script|<iframe|<object|<embed|javascript:|vbscript:|data:text\/html|data:image\/svg|onerror\s*=|onload\s*=|onclick\s*=/i.test(s);
}

function isValidUrl(url) {
  if (!url) return false;
  const s = String(url).trim().toLowerCase();
  if (s.startsWith('data:')) {
    return s.startsWith('data:image/png') || s.startsWith('data:image/jpeg') ||
           s.startsWith('data:image/jpg') || s.startsWith('data:image/gif') ||
           s.startsWith('data:image/webp') || s.startsWith('data:video/mp4') ||
           s.startsWith('data:video/webm') || s.startsWith('data:audio/');
  }
  if (s.startsWith('javascript:') || s.startsWith('vbscript:') || s.startsWith('file:')) return false;
  return true;
}

// ============================================================
// ИНИЦИАЛИЗАЦИЯ БД
// ============================================================
async function initDB() {
  console.log('Инициализация таблиц...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      avatar TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      status VARCHAR(255) DEFAULT 'Всем привет! Я в сети!',
      role VARCHAR(20) DEFAULT 'user',
      banned BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      image TEXT DEFAULT '',
      video TEXT DEFAULT '',
      gif TEXT DEFAULT '',
      sticker TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS likes (
      id SERIAL PRIMARY KEY,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      to_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      sticker TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS message_media (
      id SERIAL PRIMARY KEY,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      media_type VARCHAR(20) DEFAULT 'image',
      url TEXT NOT NULL,
      filename VARCHAR(255) DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS forums (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      description TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS forum_topics (
      id SERIAL PRIMARY KEY,
      forum_id INTEGER REFERENCES forums(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS forum_posts (
      id SERIAL PRIMARY KEY,
      topic_id INTEGER REFERENCES forum_topics(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      description TEXT DEFAULT '',
      avatar TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_members (
      id SERIAL PRIMARY KEY,
      group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_posts (
      id SERIAL PRIMARY KEY,
      group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      image TEXT DEFAULT '',
      video TEXT DEFAULT '',
      gif TEXT DEFAULT '',
      sticker TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_post_likes (
      id SERIAL PRIMARY KEY,
      post_id INTEGER REFERENCES group_posts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      content TEXT NOT NULL,
      image TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS parties (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      description TEXT DEFAULT '',
      logo TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      party_id INTEGER REFERENCES parties(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id)
    );

    CREATE TABLE IF NOT EXISTS stories (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT DEFAULT '',
      image TEXT DEFAULT '',
      video TEXT DEFAULT '',
      background VARCHAR(100) DEFAULT '#3b5998',
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours'
    );

    CREATE TABLE IF NOT EXISTS story_views (
      id SERIAL PRIMARY KEY,
      story_id INTEGER REFERENCES stories(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      viewed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(story_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS profile_gallery (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      media_type VARCHAR(20) DEFAULT 'image',
      title VARCHAR(255) DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      username VARCHAR(50),
      action VARCHAR(50) NOT NULL,
      details TEXT DEFAULT '',
      ip VARCHAR(50) DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scratch_games (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      description TEXT DEFAULT '',
      scratch_id VARCHAR(50) NOT NULL,
      cover TEXT DEFAULT '',
      plays INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scratch_likes (
      id SERIAL PRIMARY KEY,
      game_id INTEGER REFERENCES scratch_games(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(game_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS flash_games (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      description TEXT DEFAULT '',
      swf_url TEXT NOT NULL,
      cover TEXT DEFAULT '',
      plays INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS flash_likes (
      id SERIAL PRIMARY KEY,
      game_id INTEGER REFERENCES flash_games(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(game_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS html_games (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      description TEXT DEFAULT '',
      code TEXT NOT NULL,
      cover TEXT DEFAULT '',
      plays INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS html_likes (
      id SERIAL PRIMARY KEY,
      game_id INTEGER REFERENCES html_games(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(game_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_user_date ON audit_log(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at);
  `);

  const alterQueries = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''`,
    `ALTER TABLE posts ADD COLUMN IF NOT EXISTS video TEXT DEFAULT ''`,
    `ALTER TABLE posts ADD COLUMN IF NOT EXISTS gif TEXT DEFAULT ''`,
    `ALTER TABLE posts ADD COLUMN IF NOT EXISTS sticker TEXT DEFAULT ''`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS sticker TEXT DEFAULT ''`,
    `ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS sticker TEXT DEFAULT ''`
  ];
  for (const q of alterQueries) {
    try { await pool.query(q); } catch (e) {}
  }

  try {
    await pool.query(`UPDATE users SET role='admin' WHERE username=$1`, [OWNER_USERNAME]);
  } catch (e) {}

  console.log('Таблицы готовы');
}

// ============================================================
// AUTH
// ============================================================
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Плохой токен' });
  }
}

async function adminOnly(req, res, next) {
  try {
    const r = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]);
    if (!r.rows[0] || r.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Только для админа' });
    }
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function audit(req, action, details = '') {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
    await pool.query(
      'INSERT INTO audit_log(user_id, username, action, details, ip) VALUES($1,$2,$3,$4,$5)',
      [req.user?.id || null, req.user?.username || null, action, details, ip]
    );
  } catch (e) {}
}

// ============================================================
// РЕГИСТРАЦИЯ / ВХОД
// ============================================================
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните поля' });
  if (username.length < 3) return res.status(400).json({ error: 'Логин минимум 3 символа' });
  if (username.length > 50) return res.status(400).json({ error: 'Логин максимум 50 символов' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Логин занят' });

    const role = username === OWNER_USERNAME ? 'admin' : 'user';
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users(username, password, role) VALUES($1,$2,$3) RETURNING id, username, role',
      [username, hash, role]
    );
    const token = jwt.sign({ id: r.rows[0].id, username, role }, JWT_SECRET);
    res.json({ token, user: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка: ' + e.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (!r.rows[0]) return res.status(400).json({ error: 'Нет такого пользователя' });
    if (r.rows[0].banned) return res.status(403).json({ error: 'Вы забанены' });
    const ok = await bcrypt.compare(password, r.rows[0].password);
    if (!ok) return res.status(400).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ id: r.rows[0].id, username: r.rows[0].username, role: r.rows[0].role }, JWT_SECRET);
    res.json({ token, user: { id: r.rows[0].id, username: r.rows[0].username, role: r.rows[0].role } });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка: ' + e.message });
  }
});

// ============================================================
// СМЕНА ПАРОЛЯ
// ============================================================
app.put('/api/me/password', auth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Заполните поля' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });
  if (newPassword.length > 100) return res.status(400).json({ error: 'Пароль слишком длинный' });
  if (oldPassword === newPassword) return res.status(400).json({ error: 'Новый пароль совпадает со старым' });

  try {
    const r = await pool.query('SELECT password FROM users WHERE id=$1', [req.user.id]);
    const ok = await bcrypt.compare(oldPassword, r.rows[0].password);
    if (!ok) {
      await audit(req, 'PASSWORD_CHANGE_FAIL', 'wrong_old_password');
      return res.status(400).json({ error: 'Неверный старый пароль' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hash, req.user.id]);
    await audit(req, 'PASSWORD_CHANGED', '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ME / ПРОФИЛЬ
// ============================================================
app.get('/api/me', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, username, avatar, status, bio, role FROM users WHERE id=$1', [req.user.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/me', auth, async (req, res) => {
  const { status, avatar, bio } = req.body;
  if (containsForbidden(status) || containsForbidden(avatar) || containsForbidden(bio)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'profile');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  try {
    await pool.query('UPDATE users SET status=$1, avatar=$2, bio=$3 WHERE id=$4',
      [status || '', avatar || '', bio || '', req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:id', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, username, avatar, status, bio, created_at FROM users WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Нет пользователя' });
    const posts = await pool.query('SELECT * FROM posts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30', [req.params.id]);
    const gallery = await pool.query('SELECT * FROM profile_gallery WHERE user_id=$1 ORDER BY created_at DESC', [req.params.id]);
    res.json({ user: r.rows[0], posts: posts.rows, gallery: gallery.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, username, avatar, status FROM users WHERE id != $1 AND banned=FALSE LIMIT 100', [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ГАЛЕРЕЯ ПРОФИЛЯ
// ============================================================
app.get('/api/profile/gallery', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM profile_gallery WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/profile/gallery', auth, async (req, res) => {
  const { url, media_type, title } = req.body;
  if (!url) return res.status(400).json({ error: 'Нет ссылки' });
  if (containsForbidden(url) || !isValidUrl(url)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'gallery');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  try {
    const r = await pool.query('INSERT INTO profile_gallery(user_id, url, media_type, title) VALUES($1,$2,$3,$4) RETURNING *',
      [req.user.id, url, media_type || 'image', title || '']);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/profile/gallery/:id', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT user_id FROM profile_gallery WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Нет' });
    if (r.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Не ваше' });
    await pool.query('DELETE FROM profile_gallery WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ИСТОРИИ
// ============================================================
app.get('/api/stories', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM stories WHERE expires_at < NOW()');
    const r = await pool.query(`
      SELECT s.*, u.username, u.avatar,
        (SELECT COUNT(*) FROM story_views WHERE story_id=s.id) AS views,
        EXISTS(SELECT 1 FROM story_views WHERE story_id=s.id AND user_id=$1) AS viewed
      FROM stories s JOIN users u ON u.id=s.user_id
      WHERE s.expires_at > NOW() ORDER BY s.created_at DESC
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stories', auth, async (req, res) => {
  const { content, image, video, background } = req.body;
  if (!content?.trim() && !image && !video) return res.status(400).json({ error: 'Пустая история' });
  if (containsForbidden(content) || containsForbidden(image) || containsForbidden(video)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'story');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  if ((image && !isValidUrl(image)) || (video && !isValidUrl(video))) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'story_url');
    return res.status(400).json({ error: 'Недопустимый URL' });
  }
  try {
    const r = await pool.query('INSERT INTO stories(user_id, content, image, video, background) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, content || '', image || '', video || '', background || '#3b5998']);
    io.emit('new_story');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stories/:id/view', auth, async (req, res) => {
  try {
    await pool.query('INSERT INTO story_views(story_id, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/stories/:id', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT user_id FROM stories WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Нет' });
    const me = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]);
    if (r.rows[0].user_id !== req.user.id && me.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Не ваша' });
    await pool.query('DELETE FROM stories WHERE id=$1', [req.params.id]);
    io.emit('new_story');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ПОСТЫ
// ============================================================
app.get('/api/posts', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*, u.username, u.avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS likes,
        EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=$1) AS liked
      FROM posts p JOIN users u ON u.id=p.user_id
      ORDER BY p.created_at DESC LIMIT 50
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts', auth, async (req, res) => {
  const { content, image, video, gif, sticker } = req.body;
  if (!content?.trim() && !image && !video && !gif && !sticker) return res.status(400).json({ error: 'Пустой пост' });
  if (containsForbidden(content) || containsForbidden(image) || containsForbidden(video) || containsForbidden(gif)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'post');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  if ((image && !isValidUrl(image)) || (video && !isValidUrl(video)) || (gif && !isValidUrl(gif))) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'post_url');
    return res.status(400).json({ error: 'Недопустимый URL' });
  }
  try {
    const r = await pool.query('INSERT INTO posts(user_id, content, image, video, gif, sticker) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, content || '', image || '', video || '', gif || '', sticker || '']);
    io.emit('new_post');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/posts/:id', auth, async (req, res) => {
  try {
    const p = await pool.query('SELECT user_id FROM posts WHERE id=$1', [req.params.id]);
    if (!p.rows[0]) return res.status(404).json({ error: 'Нет' });
    const me = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]);
    if (p.rows[0].user_id !== req.user.id && me.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Не ваш' });
    await pool.query('DELETE FROM posts WHERE id=$1', [req.params.id]);
    io.emit('new_post');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/like/:id', auth, async (req, res) => {
  try {
    const exists = await pool.query('SELECT 1 FROM likes WHERE post_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (exists.rows[0]) {
      await pool.query('DELETE FROM likes WHERE post_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO likes(post_id, user_id) VALUES($1,$2)', [req.params.id, req.user.id]);
      res.json({ liked: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// СООБЩЕНИЯ
// ============================================================
app.get('/api/messages/:userId', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT m.*, COALESCE((SELECT json_agg(json_build_object('type', media_type, 'url', url, 'filename', filename))
        FROM message_media WHERE message_id=m.id), '[]'::json) AS media
      FROM messages m
      WHERE (m.from_id=$1 AND m.to_id=$2) OR (m.from_id=$2 AND m.to_id=$1)
      ORDER BY m.created_at ASC LIMIT 200
    `, [req.user.id, req.params.userId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/:userId', auth, async (req, res) => {
  const { content, media, sticker } = req.body;
  if (!content?.trim() && (!media || !media.length) && !sticker) return res.status(400).json({ error: 'Пусто' });
  if (containsForbidden(content)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'message');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  if (media && media.length) {
    for (const m of media) {
      if (containsForbidden(m.url?.slice(0, 500) || '')) {
        await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'message_media');
        return res.status(400).json({ error: 'Запрещённое вложение' });
      }
    }
  }
  try {
    const r = await pool.query('INSERT INTO messages(from_id, to_id, content, sticker) VALUES($1,$2,$3,$4) RETURNING *',
      [req.user.id, req.params.userId, content || '', sticker || '']);
    const msg = r.rows[0];
    if (media && media.length) {
      for (const m of media) {
        await pool.query('INSERT INTO message_media(message_id, media_type, url, filename) VALUES($1,$2,$3,$4)',
          [msg.id, m.type || 'image', m.url, m.filename || '']);
      }
    }
    const full = await pool.query(`
      SELECT m.*, COALESCE((SELECT json_agg(json_build_object('type', media_type, 'url', url, 'filename', filename))
        FROM message_media WHERE message_id=m.id), '[]'::json) AS media
      FROM messages m WHERE m.id=$1
    `, [msg.id]);
    const payload = { ...full.rows[0], from_username: req.user.username };
    io.to('user_' + req.params.userId).emit('new_message', payload);
    res.json(full.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ФОРУМЫ
// ============================================================
app.get('/api/forums', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT f.*, u.username AS author,
        (SELECT COUNT(*) FROM forum_topics WHERE forum_id=f.id) AS topics_count,
        (SELECT COUNT(*) FROM forum_posts fp JOIN forum_topics ft ON ft.id=fp.topic_id WHERE ft.forum_id=f.id) AS posts_count
      FROM forums f LEFT JOIN users u ON u.id=f.created_by ORDER BY f.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/forums', auth, async (req, res) => {
  const { title, description } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Введите название' });
  if (containsForbidden(title) || containsForbidden(description)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'forum');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  try {
    const r = await pool.query('INSERT INTO forums(title, description, created_by) VALUES($1,$2,$3) RETURNING *',
      [title, description || '', req.user.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/forums/:id', auth, async (req, res) => {
  try {
    const f = await pool.query(`SELECT f.*, u.username AS author FROM forums f LEFT JOIN users u ON u.id=f.created_by WHERE f.id=$1`, [req.params.id]);
    if (!f.rows[0]) return res.status(404).json({ error: 'Нет' });
    const topics = await pool.query(`
      SELECT t.*, u.username AS author,
        (SELECT COUNT(*) FROM forum_posts WHERE topic_id=t.id) AS posts_count
      FROM forum_topics t LEFT JOIN users u ON u.id=t.user_id
      WHERE t.forum_id=$1 ORDER BY t.created_at DESC
    `, [req.params.id]);
    res.json({ forum: f.rows[0], topics: topics.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/forums/:id/topics', auth, async (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Введите название' });
  if (containsForbidden(title)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'topic');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  try {
    const r = await pool.query('INSERT INTO forum_topics(forum_id, user_id, title) VALUES($1,$2,$3) RETURNING *',
      [req.params.id, req.user.id, title]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/topics/:id', auth, async (req, res) => {
  try {
    const t = await pool.query(`
      SELECT t.*, u.username AS author, f.title AS forum_title, f.id AS forum_id
      FROM forum_topics t LEFT JOIN users u ON u.id=t.user_id
      LEFT JOIN forums f ON f.id=t.forum_id WHERE t.id=$1
    `, [req.params.id]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Нет' });
    const posts = await pool.query(`
      SELECT fp.*, u.username, u.avatar FROM forum_posts fp
      LEFT JOIN users u ON u.id=fp.user_id WHERE fp.topic_id=$1 ORDER BY fp.created_at ASC
    `, [req.params.id]);
    res.json({ topic: t.rows[0], posts: posts.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/topics/:id/posts', auth, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Пусто' });
  if (containsForbidden(content)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'forum_post');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  try {
    const r = await pool.query('INSERT INTO forum_posts(topic_id, user_id, content) VALUES($1,$2,$3) RETURNING *',
      [req.params.id, req.user.id, content]);
    const full = await pool.query(`SELECT fp.*, u.username, u.avatar FROM forum_posts fp LEFT JOIN users u ON u.id=fp.user_id WHERE fp.id=$1`, [r.rows[0].id]);
    io.emit('new_forum_post', { topic_id: Number(req.params.id) });
    res.json(full.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ГРУППЫ
// ============================================================
app.get('/api/groups', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT g.*, u.username AS author,
        (SELECT COUNT(*) FROM group_members WHERE group_id=g.id) AS members_count,
        EXISTS(SELECT 1 FROM group_members WHERE group_id=g.id AND user_id=$1) AS is_member
      FROM groups g LEFT JOIN users u ON u.id=g.created_by ORDER BY g.created_at DESC
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups', auth, async (req, res) => {
  const { name, description, avatar } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Введите название' });
  if (containsForbidden(name) || containsForbidden(description) || containsForbidden(avatar)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'group');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  try {
    const r = await pool.query('INSERT INTO groups(name, description, avatar, created_by) VALUES($1,$2,$3,$4) RETURNING *',
      [name, description || '', avatar || '', req.user.id]);
    await pool.query('INSERT INTO group_members(group_id, user_id, role) VALUES($1,$2,$3)',
      [r.rows[0].id, req.user.id, 'admin']);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/groups/:id', auth, async (req, res) => {
  try {
    const g = await pool.query(`
      SELECT g.*, u.username AS author,
        (SELECT COUNT(*) FROM group_members WHERE group_id=g.id) AS members_count,
        EXISTS(SELECT 1 FROM group_members WHERE group_id=g.id AND user_id=$1) AS is_member,
        (SELECT role FROM group_members WHERE group_id=g.id AND user_id=$1) AS my_role
      FROM groups g LEFT JOIN users u ON u.id=g.created_by WHERE g.id=$2
    `, [req.user.id, req.params.id]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Нет' });
    res.json(g.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/:id/join', auth, async (req, res) => {
  try {
    const exists = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (exists.rows[0]) {
      await pool.query('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
      res.json({ joined: false });
    } else {
      await pool.query('INSERT INTO group_members(group_id, user_id, role) VALUES($1,$2,$3)', [req.params.id, req.user.id, 'member']);
      res.json({ joined: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/groups/:id/posts', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT gp.*, u.username, u.avatar,
        (SELECT COUNT(*) FROM group_post_likes WHERE post_id=gp.id) AS likes,
        EXISTS(SELECT 1 FROM group_post_likes WHERE post_id=gp.id AND user_id=$1) AS liked
      FROM group_posts gp JOIN users u ON u.id=gp.user_id
      WHERE gp.group_id=$2 ORDER BY gp.created_at DESC LIMIT 50
    `, [req.user.id, req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/:id/posts', auth, async (req, res) => {
  const { content, image, video, gif, sticker } = req.body;
  if (!content?.trim() && !image && !video && !gif && !sticker) return res.status(400).json({ error: 'Пусто' });
  if (containsForbidden(content) || containsForbidden(image) || containsForbidden(video) || containsForbidden(gif)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'group_post');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  if ((image && !isValidUrl(image)) || (video && !isValidUrl(video)) || (gif && !isValidUrl(gif))) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'group_post_url');
    return res.status(400).json({ error: 'Недопустимый URL' });
  }
  try {
    const member = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!member.rows[0]) return res.status(403).json({ error: 'Вы не в группе' });
    const r = await pool.query(
      'INSERT INTO group_posts(group_id, user_id, content, image, video, gif, sticker) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.params.id, req.user.id, content || '', image || '', video || '', gif || '', sticker || '']);
    io.emit('new_group_post', { group_id: Number(req.params.id) });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/group-like/:id', auth, async (req, res) => {
  try {
    const exists = await pool.query('SELECT 1 FROM group_post_likes WHERE post_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (exists.rows[0]) {
      await pool.query('DELETE FROM group_post_likes WHERE post_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO group_post_likes(post_id, user_id) VALUES($1,$2)', [req.params.id, req.user.id]);
      res.json({ liked: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/groups/:id/members', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT u.id, u.username, u.avatar, gm.role FROM group_members gm
      JOIN users u ON u.id=gm.user_id WHERE gm.group_id=$1 ORDER BY gm.joined_at ASC
    `, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// НОВОСТИ
// ============================================================
app.get('/api/news', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM news ORDER BY created_at DESC LIMIT 50');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/news', auth, adminOnly, async (req, res) => {
  const { title, content, image } = req.body;
  if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: 'Заполните' });
  if (containsForbidden(title) || containsForbidden(content) || containsForbidden(image)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'news');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  if (image && !isValidUrl(image)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'news_url');
    return res.status(400).json({ error: 'Недопустимый URL' });
  }
  try {
    const r = await pool.query('INSERT INTO news(title, content, image) VALUES($1,$2,$3) RETURNING *',
      [title, content, image || '']);
    io.emit('new_news');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/news/:id', auth, adminOnly, async (req, res) => {
  try { await pool.query('DELETE FROM news WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ПАРТИИ
// ============================================================
app.get('/api/parties', auth, async (req, res) => {
  try {
    const parties = await pool.query(`SELECT p.*, (SELECT COUNT(*) FROM votes WHERE party_id=p.id) AS votes FROM parties p ORDER BY p.created_at ASC`);
    const myVote = await pool.query('SELECT party_id FROM votes WHERE user_id=$1', [req.user.id]);
    res.json({ parties: parties.rows, myVote: myVote.rows[0]?.party_id || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/parties', auth, adminOnly, async (req, res) => {
  const { name, description, logo } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Введите название' });
  if (containsForbidden(name) || containsForbidden(description) || containsForbidden(logo)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'party');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  try {
    const r = await pool.query('INSERT INTO parties(name, description, logo) VALUES($1,$2,$3) RETURNING *',
      [name, description || '', logo || '']);
    io.emit('new_vote');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/parties/:id', auth, adminOnly, async (req, res) => {
  try { await pool.query('DELETE FROM parties WHERE id=$1', [req.params.id]); io.emit('new_vote'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/parties/vote/:id', auth, async (req, res) => {
  try {
    const existing = await pool.query('SELECT party_id FROM votes WHERE user_id=$1', [req.user.id]);
    if (existing.rows[0]) return res.status(400).json({ error: 'Вы уже голосовали' });
    await pool.query('INSERT INTO votes(user_id, party_id) VALUES($1,$2)', [req.user.id, req.params.id]);
    io.emit('new_vote');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// SCRATCH-ИГРЫ
// ============================================================
app.get('/api/scratch', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT g.*, u.username AS author,
        (SELECT COUNT(*) FROM scratch_likes WHERE game_id=g.id) AS likes,
        EXISTS(SELECT 1 FROM scratch_likes WHERE game_id=g.id AND user_id=$1) AS liked
      FROM scratch_games g LEFT JOIN users u ON u.id=g.user_id
      ORDER BY g.created_at DESC LIMIT 100
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scratch', auth, async (req, res) => {
  const { title, description, scratch_url, cover } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Введите название' });
  if (!scratch_url?.trim()) return res.status(400).json({ error: 'Введите ссылку' });
  const m = scratch_url.match(/scratch\.mit\.edu\/projects\/(\d+)/);
  if (!m) return res.status(400).json({ error: 'Формат: https://scratch.mit.edu/projects/123456' });
  if (containsForbidden(title) || containsForbidden(description)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'scratch');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  try {
    const r = await pool.query('INSERT INTO scratch_games(user_id, title, description, scratch_id, cover) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, title, description || '', m[1], cover || '']);
    io.emit('new_game');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/scratch/:id', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT g.*, u.username AS author,
        (SELECT COUNT(*) FROM scratch_likes WHERE game_id=g.id) AS likes,
        EXISTS(SELECT 1 FROM scratch_likes WHERE game_id=g.id AND user_id=$1) AS liked
      FROM scratch_games g LEFT JOIN users u ON u.id=g.user_id WHERE g.id=$2
    `, [req.user.id, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Не найдено' });
    await pool.query('UPDATE scratch_games SET plays=plays+1 WHERE id=$1', [req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/scratch/:id', auth, async (req, res) => {
  try {
    const g = await pool.query('SELECT user_id FROM scratch_games WHERE id=$1', [req.params.id]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Нет' });
    const me = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]);
    if (g.rows[0].user_id !== req.user.id && me.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Не ваша' });
    await pool.query('DELETE FROM scratch_games WHERE id=$1', [req.params.id]);
    io.emit('new_game');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scratch/:id/like', auth, async (req, res) => {
  try {
    const exists = await pool.query('SELECT 1 FROM scratch_likes WHERE game_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (exists.rows[0]) {
      await pool.query('DELETE FROM scratch_likes WHERE game_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO scratch_likes(game_id, user_id) VALUES($1,$2)', [req.params.id, req.user.id]);
      res.json({ liked: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// FLASH-ИГРЫ
// ============================================================
app.get('/api/flash', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT g.*, u.username AS author,
        (SELECT COUNT(*) FROM flash_likes WHERE game_id=g.id) AS likes,
        EXISTS(SELECT 1 FROM flash_likes WHERE game_id=g.id AND user_id=$1) AS liked
      FROM flash_games g LEFT JOIN users u ON u.id=g.user_id
      ORDER BY g.created_at DESC LIMIT 100
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/flash', auth, async (req, res) => {
  const { title, description, swf_url, cover } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Введите название' });
  if (!swf_url?.trim()) return res.status(400).json({ error: 'Введите URL .swf' });
  if (!isValidUrl(swf_url)) return res.status(400).json({ error: 'Недопустимый URL' });
  if (containsForbidden(title) || containsForbidden(description)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'flash');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  try {
    const r = await pool.query('INSERT INTO flash_games(user_id, title, description, swf_url, cover) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, title, description || '', swf_url, cover || '']);
    io.emit('new_game');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/flash/:id', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT g.*, u.username AS author,
        (SELECT COUNT(*) FROM flash_likes WHERE game_id=g.id) AS likes,
        EXISTS(SELECT 1 FROM flash_likes WHERE game_id=g.id AND user_id=$1) AS liked
      FROM flash_games g LEFT JOIN users u ON u.id=g.user_id WHERE g.id=$2
    `, [req.user.id, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Не найдено' });
    await pool.query('UPDATE flash_games SET plays=plays+1 WHERE id=$1', [req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/flash/:id', auth, async (req, res) => {
  try {
    const g = await pool.query('SELECT user_id FROM flash_games WHERE id=$1', [req.params.id]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Нет' });
    const me = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]);
    if (g.rows[0].user_id !== req.user.id && me.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Не ваша' });
    await pool.query('DELETE FROM flash_games WHERE id=$1', [req.params.id]);
    io.emit('new_game');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/flash/:id/like', auth, async (req, res) => {
  try {
    const exists = await pool.query('SELECT 1 FROM flash_likes WHERE game_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (exists.rows[0]) {
      await pool.query('DELETE FROM flash_likes WHERE game_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO flash_likes(game_id, user_id) VALUES($1,$2)', [req.params.id, req.user.id]);
      res.json({ liked: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// HTML5-РЕДАКТОР ИГР
// ============================================================
app.get('/api/htmlgames', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT g.id, g.title, g.description, g.cover, g.plays, g.created_at, g.user_id, u.username AS author,
        (SELECT COUNT(*) FROM html_likes WHERE game_id=g.id) AS likes,
        EXISTS(SELECT 1 FROM html_likes WHERE game_id=g.id AND user_id=$1) AS liked
      FROM html_games g LEFT JOIN users u ON u.id=g.user_id
      ORDER BY g.created_at DESC LIMIT 100
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/htmlgames/:id/code', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT g.*, u.username AS author,
        (SELECT COUNT(*) FROM html_likes WHERE game_id=g.id) AS likes,
        EXISTS(SELECT 1 FROM html_likes WHERE game_id=g.id AND user_id=$1) AS liked
      FROM html_games g LEFT JOIN users u ON u.id=g.user_id WHERE g.id=$2
    `, [req.user.id, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Не найдено' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/htmlgames/:id', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT g.id, g.title, g.description, g.cover, g.plays, g.created_at, g.user_id, u.username AS author,
        (SELECT COUNT(*) FROM html_likes WHERE game_id=g.id) AS likes,
        EXISTS(SELECT 1 FROM html_likes WHERE game_id=g.id AND user_id=$1) AS liked
      FROM html_games g LEFT JOIN users u ON u.id=g.user_id WHERE g.id=$2
    `, [req.user.id, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Не найдено' });
    await pool.query('UPDATE html_games SET plays=plays+1 WHERE id=$1', [req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/htmlgames', auth, async (req, res) => {
  const { title, description, code, cover } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Введите название' });
  if (!code?.trim()) return res.status(400).json({ error: 'Введите код игры' });
  if (code.length > 200000) return res.status(400).json({ error: 'Код слишком большой (макс. 200 КБ)' });
  if (containsForbidden(title) || containsForbidden(description)) {
    await audit(req, 'FORBIDDEN_CONTENT_ATTEMPT', 'html_game');
    return res.status(400).json({ error: 'Запрещённый контент' });
  }
  try {
    const r = await pool.query('INSERT INTO html_games(user_id, title, description, code, cover) VALUES($1,$2,$3,$4,$5) RETURNING id, title, description, cover, plays, created_at, user_id',
      [req.user.id, title, description || '', code, cover || '']);
    io.emit('new_game');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/htmlgames/:id', auth, async (req, res) => {
  const { title, description, code, cover } = req.body;
  try {
    const g = await pool.query('SELECT user_id FROM html_games WHERE id=$1', [req.params.id]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Нет' });
    const me = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]);
    if (g.rows[0].user_id !== req.user.id && me.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Не ваша' });
    await pool.query('UPDATE html_games SET title=$1, description=$2, code=$3, cover=$4 WHERE id=$5',
      [title, description || '', code, cover || '', req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/htmlgames/:id', auth, async (req, res) => {
  try {
    const g = await pool.query('SELECT user_id FROM html_games WHERE id=$1', [req.params.id]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Нет' });
    const me = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]);
    if (g.rows[0].user_id !== req.user.id && me.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Не ваша' });
    await pool.query('DELETE FROM html_games WHERE id=$1', [req.params.id]);
    io.emit('new_game');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/htmlgames/:id/like', auth, async (req, res) => {
  try {
    const exists = await pool.query('SELECT 1 FROM html_likes WHERE game_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (exists.rows[0]) {
      await pool.query('DELETE FROM html_likes WHERE game_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO html_likes(game_id, user_id) VALUES($1,$2)', [req.params.id, req.user.id]);
      res.json({ liked: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ПОИСК
// ============================================================
app.get('/api/search/suggest', auth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ users: [], groups: [], forums: [], posts: [] });
  const pattern = '%' + q.toLowerCase() + '%';
  try {
    const users = await pool.query(`SELECT id, username, avatar FROM users WHERE LOWER(username) LIKE $1 AND id != $2 AND banned=FALSE LIMIT 5`, [pattern, req.user.id]);
    const groups = await pool.query(`SELECT id, name, avatar FROM groups WHERE LOWER(name) LIKE $1 LIMIT 5`, [pattern]);
    const forums = await pool.query(`SELECT id, title FROM forums WHERE LOWER(title) LIKE $1 LIMIT 5`, [pattern]);
    const posts = await pool.query(`SELECT id, content FROM posts WHERE LOWER(content) LIKE $1 LIMIT 5`, [pattern]);
    res.json({ users: users.rows, groups: groups.rows, forums: forums.rows, posts: posts.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search', auth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ users: [], posts: [], groups: [], forums: [] });
  const pattern = '%' + q.toLowerCase() + '%';
  try {
    const users = await pool.query(`SELECT id, username, avatar, status FROM users WHERE LOWER(username) LIKE $1 AND id != $2 AND banned=FALSE LIMIT 20`, [pattern, req.user.id]);
    const posts = await pool.query(`SELECT p.*, u.username, u.avatar, (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS likes FROM posts p JOIN users u ON u.id=p.user_id WHERE LOWER(p.content) LIKE $1 ORDER BY p.created_at DESC LIMIT 20`, [pattern]);
    const groups = await pool.query(`SELECT g.*, (SELECT COUNT(*) FROM group_members WHERE group_id=g.id) AS members_count FROM groups g WHERE LOWER(g.name) LIKE $1 OR LOWER(g.description) LIKE $1 LIMIT 20`, [pattern]);
    const forums = await pool.query(`SELECT f.*, (SELECT COUNT(*) FROM forum_topics WHERE forum_id=f.id) AS topics_count FROM forums f WHERE LOWER(f.title) LIKE $1 OR LOWER(f.description) LIKE $1 LIMIT 20`, [pattern]);
    res.json({ users: users.rows, posts: posts.rows, groups: groups.rows, forums: forums.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ЛОГ XSS-ПОПЫТОК
// ============================================================
app.post('/api/security/attempt', auth, async (req, res) => {
  const { reason } = req.body;
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
    await pool.query(
      'INSERT INTO audit_log(user_id, username, action, details, ip) VALUES($1,$2,$3,$4,$5)',
      [req.user.id, req.user.username, 'FORBIDDEN_CONTENT_ATTEMPT', (reason || 'unknown').slice(0, 500), ip]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// АДМИНКА
// ============================================================
app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  try {
    const [u, p, g, f, t, m, n] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM posts'),
      pool.query('SELECT COUNT(*) FROM groups'),
      pool.query('SELECT COUNT(*) FROM forums'),
      pool.query('SELECT COUNT(*) FROM forum_topics'),
      pool.query('SELECT COUNT(*) FROM messages'),
      pool.query('SELECT COUNT(*) FROM news')
    ]);
    res.json({
      users: Number(u.rows[0].count), posts: Number(p.rows[0].count),
      groups: Number(g.rows[0].count), forums: Number(f.rows[0].count),
      topics: Number(t.rows[0].count), messages: Number(m.rows[0].count),
      news: Number(n.rows[0].count)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, username, role, banned, created_at, (SELECT COUNT(*) FROM posts WHERE user_id=users.id) AS posts_count FROM users ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/ban/:id', auth, adminOnly, async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Себя нельзя' });
  try {
    const r = await pool.query('SELECT banned FROM users WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Нет' });
    await pool.query('UPDATE users SET banned=$1 WHERE id=$2', [!r.rows[0].banned, req.params.id]);
    await audit(req, 'ban', 'target=' + req.params.id);
    res.json({ banned: !r.rows[0].banned });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Себя нельзя' });
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    await audit(req, 'delete_user', 'target=' + req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/posts/:id', auth, adminOnly, async (req, res) => {
  try { await pool.query('DELETE FROM posts WHERE id=$1', [req.params.id]); io.emit('new_post'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/groups/:id', auth, adminOnly, async (req, res) => {
  try { await pool.query('DELETE FROM groups WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/forums/:id', auth, adminOnly, async (req, res) => {
  try { await pool.query('DELETE FROM forums WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/audit', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// SOCKET.IO
// ============================================================
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    next();
  } catch { next(new Error('unauthorized')); }
});

const online = new Set();

io.on('connection', (socket) => {
  online.add(socket.user.id);
  socket.join('user_' + socket.user.id);
  io.emit('online', Array.from(online));

  socket.on('disconnect', () => {
    online.delete(socket.user.id);
    io.emit('online', Array.from(online));
  });

  socket.on('call:start', ({ to, type }) => io.to('user_' + to).emit('call:incoming', { from: socket.user.id, fromName: socket.user.username, type }));
  socket.on('call:accept', ({ to }) => io.to('user_' + to).emit('call:accepted', { from: socket.user.id }));
  socket.on('call:reject', ({ to }) => io.to('user_' + to).emit('call:rejected', { from: socket.user.id }));
  socket.on('call:end', ({ to }) => io.to('user_' + to).emit('call:ended', { from: socket.user.id }));
  socket.on('webrtc:offer', ({ to, offer }) => io.to('user_' + to).emit('webrtc:offer', { from: socket.user.id, offer }));
  socket.on('webrtc:answer', ({ to, answer }) => io.to('user_' + to).emit('webrtc:answer', { from: socket.user.id, answer }));
  socket.on('webrtc:ice', ({ to, candidate }) => io.to('user_' + to).emit('webrtc:ice', { from: socket.user.id, candidate }));
});

// ============================================================
// ЗАПУСК
// ============================================================
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => server.listen(PORT, () => console.log(`Сервер на порту ${PORT}`)))
  .catch((err) => {
    console.error('FATAL:', err);
    server.listen(PORT, () => console.log(`Без БД на порту ${PORT}`));
  });
