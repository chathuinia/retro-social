// ============================================================
// РетроСеть 2010 — server.js
// Node.js + Express + PostgreSQL + Socket.io
// ============================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');

// ============================================================
// КОНФИГ
// ============================================================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'retro-secret-change-me';
const OWNER_USERNAMES = ['lol', 'qwyrta'];

// Supabase Storage (опционально; если нет — файлы не грузятся)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'retro';
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ============================================================
// БАЗА ДАННЫХ
// ============================================================
// ВНИМАНИЕ: строка подключения вписана прямо в код (по просьбе).
// Перед публикацией в GitHub замените на process.env.DATABASE_URL.
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_yOQcIwub8V6N@ep-solitary-rain-a5orxtnv-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  ssl: { rejectUnauthorized: false }
});

async function query(text, params) {
  return pool.query(text, params);
}

// ============================================================
// ХЕЛПЕРЫ
// ============================================================

// XSS-экранирование (на случай если фронт забудет)
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Валидация URL: запрещаем javascript:, data:image/svg
function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed.length > 2000) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:')) return false;
  if (lower.startsWith('data:image/svg')) return false;
  if (lower.startsWith('data:text/html')) return false;
  if (!/^https?:\/\//i.test(trimmed) && !/^\//.test(trimmed)) return false;
  return true;
}

// NSFW-фильтр (базовый список)
const NSFW_WORDS = ['порно', 'секс', 'хуй', 'пизда', 'ебать', 'блядь', 'сука', 'нахуй'];
function nsfwFilter(text) {
  if (!text) return '';
  let out = String(text);
  for (const w of NSFW_WORDS) {
    const re = new RegExp(w, 'gi');
    out = out.replace(re, '*'.repeat(w.length));
  }
  return out;
}

// Простая проверка префикса
function validatePrefix(text) {
  if (!text || text.length > 20) return false;
  return !NSFW_WORDS.some(w => text.toLowerCase().includes(w));
}

// ============================================================
// ИНИЦИАЛИЗАЦИЯ СХЕМЫ БД
// ============================================================
async function initDb() {
  const sql = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(32) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role VARCHAR(16) DEFAULT 'user',
    avatar TEXT DEFAULT '',
    status TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    coins INTEGER DEFAULT 0,
    banned BOOLEAN DEFAULT FALSE,
    prefix TEXT DEFAULT '',
    nick_color TEXT DEFAULT '',
    theme VARCHAR(16) DEFAULT 'aero',
    friends_slots INTEGER DEFAULT 100,
    last_daily TIMESTAMP,
    daily_posts INT DEFAULT 0,
    daily_forum INT DEFAULT 0,
    daily_likes INT DEFAULT 0,
    daily_reset DATE,
    last_seen TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text TEXT DEFAULT '',
    image TEXT DEFAULT '',
    video TEXT DEFAULT '',
    gif TEXT DEFAULT '',
    sticker TEXT DEFAULT '',
    promoted_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS likes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    UNIQUE(user_id, post_id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    from_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    to_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text TEXT DEFAULT '',
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS message_media (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    type VARCHAR(16),
    url TEXT
  );

  CREATE TABLE IF NOT EXISTS forums (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS forum_topics (
    id SERIAL PRIMARY KEY,
    forum_id INTEGER REFERENCES forums(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS forum_posts (
    id SERIAL PRIMARY KEY,
    topic_id INTEGER REFERENCES forum_topics(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS group_members (
    id SERIAL PRIMARY KEY,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(16) DEFAULT 'member',
    UNIQUE(group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_posts (
    id SERIAL PRIMARY KEY,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text TEXT DEFAULT '',
    image TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS group_post_likes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER REFERENCES group_posts(id) ON DELETE CASCADE,
    UNIQUE(user_id, post_id)
  );

  CREATE TABLE IF NOT EXISTS stories (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text TEXT DEFAULT '',
    bg TEXT DEFAULT '#87CEEB',
    image TEXT DEFAULT '',
    video TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS story_views (
    id SERIAL PRIMARY KEY,
    story_id INTEGER REFERENCES stories(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(story_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS profile_gallery (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    type VARCHAR(16) DEFAULT 'image',
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS news (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    image TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS scratch_games (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    embed_url TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    plays INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS scratch_likes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    game_id INTEGER REFERENCES scratch_games(id) ON DELETE CASCADE,
    UNIQUE(user_id, game_id)
  );

  CREATE TABLE IF NOT EXISTS flash_games (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    embed_url TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    plays INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS flash_likes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    game_id INTEGER REFERENCES flash_games(id) ON DELETE CASCADE,
    UNIQUE(user_id, game_id)
  );

  CREATE TABLE IF NOT EXISTS html_games (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    code TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    plays INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS html_likes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    game_id INTEGER REFERENCES html_games(id) ON DELETE CASCADE,
    UNIQUE(user_id, game_id)
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT DEFAULT '',
    genre VARCHAR(32) DEFAULT '',
    url TEXT NOT NULL,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    plays INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS track_likes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
    UNIQUE(user_id, track_id)
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS playlist_tracks (
    id SERIAL PRIMARY KEY,
    playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
    track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
    UNIQUE(playlist_id, track_id)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    details TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS coin_transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    balance_after INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS prefixes (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    price_coins INTEGER NOT NULL,
    type VARCHAR(16) DEFAULT 'standard',
    is_active BOOLEAN DEFAULT TRUE
  );

  CREATE TABLE IF NOT EXISTS user_prefixes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    prefix_id INTEGER REFERENCES prefixes(id) ON DELETE CASCADE,
    custom_text TEXT DEFAULT '',
    equipped BOOLEAN DEFAULT FALSE,
    bought_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS contests (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    prize_coins INTEGER NOT NULL,
    deadline TIMESTAMP,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(16) DEFAULT 'active',
    winner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS contest_entries (
    id SERIAL PRIMARY KEY,
    contest_id INTEGER REFERENCES contests(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    entry_text TEXT DEFAULT '',
    entry_url TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
  );
  `;
  await pool.query(sql);

  // Seed префиксы (если пусто)
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM prefixes');
  if (rows[0].c === 0) {
    await pool.query(
      `INSERT INTO prefixes (name, price_coins, type) VALUES
       ('Любитель ретро', 500, 'standard'),
       ('Мемолог', 300, 'standard'),
       ('Полуночник', 200, 'standard'),
       ('Музыкант', 400, 'standard'),
       ('Геймер', 400, 'standard'),
       ('Ветеран', 1000, 'standard'),
       ('Легенда', 5000, 'standard'),
       ('Свой префикс', 2000, 'custom')`
    );
  }

  // Seed владельцев
  for (const uname of OWNER_USERNAMES) {
    const exists = await pool.query('SELECT id FROM users WHERE username = $1', [uname]);
    if (exists.rows.length === 0) {
      const hash = await bcrypt.hash('owner' + uname, 10);
      await pool.query(
        `INSERT INTO users (username, password_hash, role, coins)
         VALUES ($1, $2, 'owner', 0)`,
        [uname, hash]
      );
      console.log('Создан владелец:', uname, '(пароль: owner' + uname + ')');
    }
  }

  console.log('База данных инициализирована');
}

// ============================================================
// АВТОРИЗАЦИЯ / УТИЛИТЫ
// ============================================================
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
    expiresIn: '30d'
  });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Невалидный токен' });
  }
}

async function loadUser(req, res, next) {
  if (!req.user) return next();
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (rows.length === 0) return res.status(401).json({ error: 'Пользователь не найден' });
  if (rows[0].banned) return res.status(403).json({ error: 'Вы забанены' });
  req.dbUser = rows[0];
  next();
}

function adminOnly(req, res, next) {
  if (!req.dbUser || (req.dbUser.role !== 'admin' && req.dbUser.role !== 'owner')) {
    return res.status(403).json({ error: 'Только для админов' });
  }
  next();
}

async function audit(adminId, action, details) {
  await query(
    'INSERT INTO audit_log (admin_id, action, details) VALUES ($1, $2, $3)',
    [adminId, action, details || '']
  );
}

function getBalance(user) {
  if (!user) return 0;
  if (user.role === 'admin' || user.role === 'owner') return Infinity;
  return user.coins;
}

// Начисление/списание монет (в одной транзакции)
async function addCoins(userId, amount, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT coins, role FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Пользователь не найден' };
    }
    const user = rows[0];
    if (user.role === 'admin' || user.role === 'owner') {
      // Админам монеты не меняем, но транзакцию пишем
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, reason, balance_after)
         VALUES ($1, $2, $3, $4)`,
        [userId, amount, reason, user.coins]
      );
      await client.query('COMMIT');
      return { ok: true, balance: Infinity };
    }
    const newBalance = user.coins + amount;
    if (newBalance < 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Недостаточно монет' };
    }
    await client.query('UPDATE users SET coins = $1 WHERE id = $2', [newBalance, userId]);
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, reason, balance_after)
       VALUES ($1, $2, $3, $4)`,
      [userId, amount, reason, newBalance]
    );
    await client.query('COMMIT');
    return { ok: true, balance: newBalance };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('addCoins error:', e);
    return { ok: false, error: 'Ошибка БД' };
  } finally {
    client.release();
  }
}

// Сброс дневных счётчиков
async function resetDailyIfNeeded(userId) {
  const { rows } = await query('SELECT daily_reset FROM users WHERE id = $1', [userId]);
  if (rows.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const last = rows[0].daily_reset ? new Date(rows[0].daily_reset).toISOString().slice(0, 10) : null;
  if (last !== today) {
    await query(
      `UPDATE users SET daily_posts = 0, daily_forum = 0, daily_likes = 0,
       daily_reset = $1 WHERE id = $2`,
      [today, userId]
    );
  }
}

// Счётчик дневной активности
async function incDaily(userId, field, max) {
  await resetDailyIfNeeded(userId);
  const { rows } = await query(`SELECT ${field} AS v FROM users WHERE id = $1`, [userId]);
  if (rows.length === 0) return false;
  if (rows[0].v >= max) return false;
  await query(`UPDATE users SET ${field} = ${field} + 1 WHERE id = $1`, [userId]);
  return true;
}

// ============================================================
// MULTER + SUPABASE UPLOAD
// ============================================================
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

async function uploadToSupabase(file, prefix) {
  if (!supabase) {
    // fallback: сохраняем как data URL (не рекомендуется для продакшена)
    if (file.size > 2 * 1024 * 1024) throw new Error('Файл слишком большой для fallback');
    return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
  }
  const ext = (file.originalname.split('.').pop() || 'bin').toLowerCase();
  const fileName = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(fileName, file.buffer, {
    contentType: file.mimetype,
    upsert: false
  });
  if (error) throw error;
  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting (на API)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Слишком много запросов, попробуйте позже' }
});
app.use('/api/', apiLimiter);

// Специальный лимит на логин/регистрацию
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Слишком много попыток входа' }
});

// ============================================================
// API: АУТЕНТИФИКАЦИЯ
// ============================================================
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: 'Логин: 3–32 символа' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Логин: только латиница, цифры и _' });
    }
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Пароль: минимум 4 символа' });
    }
    const exists = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Логин занят' });
    const hash = await bcrypt.hash(password, 10);
    const role = OWNER_USERNAMES.includes(username) ? 'owner' : 'user';
    const { rows } = await query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)
       RETURNING id, username, role, coins`,
      [username, hash, role]
    );
    const user = rows[0];
    const token = signToken(user);
    res.json({ token, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните поля' });
    const { rows } = await query('SELECT * FROM users WHERE username = $1', [username]);
    if (rows.length === 0) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const user = rows[0];
    if (user.banned) return res.status(403).json({ error: 'Вы забанены' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Неверный логин или пароль' });

    // Ежедневный вход
    await resetDailyIfNeeded(user.id);
    const today = new Date().toISOString().slice(0, 10);
    const lastDaily = user.last_daily ? new Date(user.last_daily).toISOString().slice(0, 10) : null;
    if (lastDaily !== today) {
      await query('UPDATE users SET last_daily = NOW() WHERE id = $1', [user.id]);
      await addCoins(user.id, 1, 'Ежедневный вход');
    }

    const token = signToken(user);
    const fresh = await query('SELECT id, username, role, coins FROM users WHERE id = $1', [user.id]);
    res.json({ token, user: fresh.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

app.get('/api/me', auth, loadUser, async (req, res) => {
  const u = req.dbUser;
  const balance = getBalance(u);
  res.json({
    id: u.id, username: u.username, role: u.role, avatar: u.avatar,
    status: u.status, bio: u.bio, coins: balance === Infinity ? 'Infinity' : u.coins,
    prefix: u.prefix, nick_color: u.nick_color, theme: u.theme
  });
});

app.post('/api/change-password', auth, loadUser, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Новый пароль: мин 4' });
    const ok = await bcrypt.compare(oldPassword, req.dbUser.password_hash);
    if (!ok) return res.status(400).json({ error: 'Старый пароль неверен' });
    const hash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.dbUser.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: ПРОФИЛЬ
// ============================================================
app.get('/api/users/:username', auth, loadUser, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, username, role, avatar, status, bio, coins, prefix, nick_color, created_at
       FROM users WHERE username = $1`,
      [req.params.username]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Нет пользователя' });
    const u = rows[0];
    const gallery = await query('SELECT * FROM profile_gallery WHERE user_id = $1 ORDER BY id DESC', [u.id]);
    const posts = await query(
      'SELECT * FROM posts WHERE user_id = $1 ORDER BY id DESC LIMIT 50',
      [u.id]
    );
    const isAdmin = req.dbUser.role === 'admin' || req.dbUser.role === 'owner';
    res.json({
      user: {
        ...u,
        coins: isAdmin ? 'Infinity' : u.coins
      },
      gallery: gallery.rows,
      posts: posts.rows
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.put('/api/profile', auth, loadUser, async (req, res) => {
  try {
    const { avatar, status, bio, nick_color, theme } = req.body;
    if (avatar && !isValidUrl(avatar)) return res.status(400).json({ error: 'Невалидный URL аватара' });
    if (status && status.length > 200) return res.status(400).json({ error: 'Статус слишком длинный' });
    if (bio && bio.length > 1000) return res.status(400).json({ error: 'Био слишком длинное' });
    if (theme && !['aero', 'nature', 'ocean', 'sunset', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Неизвестная тема' });
    }
    await query(
      `UPDATE users SET
         avatar = COALESCE($1, avatar),
         status = COALESCE($2, status),
         bio = COALESCE($3, bio),
         nick_color = COALESCE($4, nick_color),
         theme = COALESCE($5, theme)
       WHERE id = $6`,
      [
        avatar || null,
        status !== undefined ? nsfwFilter(status) : null,
        bio !== undefined ? nsfwFilter(bio) : null,
        nick_color || null,
        theme || null,
        req.dbUser.id
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/profile/gallery', auth, loadUser, async (req, res) => {
  try {
    const { url, type } = req.body;
    if (!isValidUrl(url)) return res.status(400).json({ error: 'Невалидный URL' });
    const t = type === 'video' ? 'video' : 'image';
    const { rows } = await query(
      'INSERT INTO profile_gallery (user_id, url, type) VALUES ($1, $2, $3) RETURNING *',
      [req.dbUser.id, url, t]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: ЗАГРУЗКА ФАЙЛОВ
// ============================================================
app.post('/api/upload', auth, loadUser, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    const prefix = req.body.type || 'misc';
    const url = await uploadToSupabase(req.file, prefix);
    res.json({ url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Ошибка загрузки' });
  }
});

// ============================================================
// API: ПОСТЫ (стена)
// ============================================================
app.get('/api/posts', auth, loadUser, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;
    const { rows } = await query(
      `SELECT p.*, u.username, u.avatar, u.prefix, u.nick_color,
        (SELECT COUNT(*)::int FROM likes WHERE post_id = p.id) AS likes_count,
        (SELECT COUNT(*)::int FROM comments WHERE post_id = p.id) AS comments_count,
        EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $1) AS liked
       FROM posts p JOIN users u ON u.id = p.user_id
       ORDER BY p.promoted_until DESC NULLS LAST, p.id DESC
       LIMIT $2 OFFSET $3`,
      [req.dbUser.id, limit, offset]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/posts', auth, loadUser, async (req, res) => {
  try {
    const { text, image, video, gif, sticker } = req.body;
    if (!text && !image && !video && !gif && !sticker) {
      return res.status(400).json({ error: 'Пустой пост' });
    }
    if (image && !isValidUrl(image)) return res.status(400).json({ error: 'Невалидный URL картинки' });
    if (video && !isValidUrl(video)) return res.status(400).json({ error: 'Невалидный URL видео' });
    if (gif && !isValidUrl(gif)) return res.status(400).json({ error: 'Невалидный URL GIF' });
    const { rows } = await query(
      `INSERT INTO posts (user_id, text, image, video, gif, sticker)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        req.dbUser.id,
        nsfwFilter(text || ''),
        image || '',
        video || '',
        gif || '',
        sticker || ''
      ]
    );
    // Монеты за пост (макс 5/день)
    if (await incDaily(req.dbUser.id, 'daily_posts', 5)) {
      await addCoins(req.dbUser.id, 1, 'Пост на стене');
    }
    io.emit('new_post', rows[0]);
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.delete('/api/posts/:id', auth, loadUser, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Нет поста' });
    if (rows[0].user_id !== req.dbUser.id && req.dbUser.role !== 'admin' && req.dbUser.role !== 'owner') {
      return res.status(403).json({ error: 'Нельзя удалить чужой пост' });
    }
    await query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/posts/:id/like', auth, loadUser, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const existing = await query(
      'SELECT id FROM likes WHERE user_id = $1 AND post_id = $2',
      [req.dbUser.id, postId]
    );
    if (existing.rows.length > 0) {
      await query('DELETE FROM likes WHERE id = $1', [existing.rows[0].id]);
      res.json({ liked: false });
    } else {
      await query('INSERT INTO likes (user_id, post_id) VALUES ($1, $2)', [req.dbUser.id, postId]);
      // 0.5 RC за лайк чужому (макс 5/день) — округление вниз: 1 RC за 2 лайка
      if (await incDaily(req.dbUser.id, 'daily_likes', 10)) {
        const cnt = await query('SELECT daily_likes FROM users WHERE id = $1', [req.dbUser.id]);
        if (cnt.rows[0].daily_likes % 2 === 0) {
          await addCoins(req.dbUser.id, 1, 'Лайки (2×0.5 RC)');
        }
      }
      res.json({ liked: true });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/posts/:id/comments', auth, loadUser, async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, u.username, u.avatar, u.prefix FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.post_id = $1 ORDER BY c.id ASC`,
    [req.params.id]
  );
  res.json(rows);
});

app.post('/api/posts/:id/comments', auth, loadUser, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Пустой комментарий' });
    const { rows } = await query(
      `INSERT INTO comments (user_id, post_id, text) VALUES ($1, $2, $3) RETURNING *`,
      [req.dbUser.id, req.params.id, nsfwFilter(text)]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: СООБЩЕНИЯ
// ============================================================
app.get('/api/dialogs', auth, loadUser, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT ON (other_id) *
       FROM (
         SELECT m.*,
           CASE WHEN m.from_id = $1 THEN m.to_id ELSE m.from_id END AS other_id
         FROM messages m
         WHERE m.from_id = $1 OR m.to_id = $1
       ) t
       ORDER BY other_id, id DESC`,
      [req.dbUser.id]
    );
    const result = [];
    for (const m of rows) {
      const u = await query(
        `SELECT id, username, avatar, last_seen FROM users WHERE id = $1`,
        [m.other_id]
      );
      const unread = await query(
        `SELECT COUNT(*)::int AS c FROM messages
         WHERE from_id = $1 AND to_id = $2 AND read = FALSE`,
        [m.other_id, req.dbUser.id]
      );
      if (u.rows.length > 0) {
        result.push({
          user: u.rows[0],
          lastMessage: m,
          unread: unread.rows[0].c
        });
      }
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/messages/:userId', auth, loadUser, async (req, res) => {
  try {
    const otherId = parseInt(req.params.userId);
    const { rows } = await query(
      `SELECT * FROM messages
       WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)
       ORDER BY id ASC LIMIT 500`,
      [req.dbUser.id, otherId]
    );
    // отметить прочитанными
    await query(
      `UPDATE messages SET read = TRUE WHERE from_id = $1 AND to_id = $2 AND read = FALSE`,
      [otherId, req.dbUser.id]
    );
    // media
    const result = [];
    for (const m of rows) {
      const media = await query('SELECT * FROM message_media WHERE message_id = $1', [m.id]);
      result.push({ ...m, media: media.rows });
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/messages/:userId', auth, loadUser, async (req, res) => {
  try {
    const otherId = parseInt(req.params.userId);
    const { text, media } = req.body;
    if (!text && (!media || media.length === 0)) {
      return res.status(400).json({ error: 'Пустое сообщение' });
    }
    const { rows } = await query(
      `INSERT INTO messages (from_id, to_id, text) VALUES ($1, $2, $3) RETURNING *`,
      [req.dbUser.id, otherId, nsfwFilter(text || '')]
    );
    const msg = rows[0];
    if (media && Array.isArray(media)) {
      for (const item of media) {
        if (item && item.type && isValidUrl(item.url)) {
          await query(
            'INSERT INTO message_media (message_id, type, url) VALUES ($1, $2, $3)',
            [msg.id, item.type, item.url]
          );
        }
      }
    }
    // socket: уведомить получателя
    const socketId = onlineUsers.get(otherId);
    if (socketId) {
      io.to(socketId).emit('new_message', {
        ...msg,
        from_username: req.dbUser.username,
        from_avatar: req.dbUser.avatar
      });
    }
    res.json(msg);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: ИСТОРИИ
// ============================================================
app.get('/api/stories', auth, loadUser, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT s.*, u.username, u.avatar,
        (SELECT COUNT(*)::int FROM story_views WHERE story_id = s.id) AS views_count
       FROM stories s JOIN users u ON u.id = s.user_id
       WHERE s.created_at > NOW() - INTERVAL '24 hours'
       ORDER BY s.id DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/stories', auth, loadUser, async (req, res) => {
  try {
    const { text, bg, image, video } = req.body;
    if (image && !isValidUrl(image)) return res.status(400).json({ error: 'URL картинки невалиден' });
    if (video && !isValidUrl(video)) return res.status(400).json({ error: 'URL видео невалиден' });
    const { rows } = await query(
      `INSERT INTO stories (user_id, text, bg, image, video)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.dbUser.id, nsfwFilter(text || ''), bg || '#87CEEB', image || '', video || '']
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/stories/:id/view', auth, loadUser, async (req, res) => {
  try {
    await query(
      'INSERT INTO story_views (story_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, req.dbUser.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: ГРУППЫ
// ============================================================
app.get('/api/groups', auth, loadUser, async (req, res) => {
  const { rows } = await query(
    `SELECT g.*, u.username AS creator,
      (SELECT COUNT(*)::int FROM group_members WHERE group_id = g.id) AS members_count
     FROM groups g LEFT JOIN users u ON u.id = g.created_by
     ORDER BY g.id DESC`
  );
  res.json(rows);
});

app.post('/api/groups', auth, loadUser, async (req, res) => {
  try {
    const { name, description, avatar } = req.body;
    if (!name || name.length > 100) return res.status(400).json({ error: 'Название: 1–100' });
    if (avatar && !isValidUrl(avatar)) return res.status(400).json({ error: 'URL аватара невалиден' });
    const { rows } = await query(
      `INSERT INTO groups (name, description, avatar, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [nsfwFilter(name), nsfwFilter(description || ''), avatar || '', req.dbUser.id]
    );
    await query(
      `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [rows[0].id, req.dbUser.id]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/groups/:id', auth, loadUser, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT g.*, u.username AS creator FROM groups g
       LEFT JOIN users u ON u.id = g.created_by WHERE g.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Группа не найдена' });
    const members = await query(
      `SELECT gm.role, u.id, u.username, u.avatar FROM group_members gm
       JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1`,
      [req.params.id]
    );
    const posts = await query(
      `SELECT gp.*, u.username, u.avatar,
        (SELECT COUNT(*)::int FROM group_post_likes WHERE post_id = gp.id) AS likes_count,
        EXISTS(SELECT 1 FROM group_post_likes WHERE post_id = gp.id AND user_id = $2) AS liked
       FROM group_posts gp JOIN users u ON u.id = gp.user_id
       WHERE gp.group_id = $1 ORDER BY gp.id DESC LIMIT 100`,
      [req.params.id, req.dbUser.id]
    );
    const isMember = members.rows.some(m => m.id === req.dbUser.id);
    res.json({ group: rows[0], members: members.rows, posts: posts.rows, isMember });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/groups/:id/join', auth, loadUser, async (req, res) => {
  try {
    const exists = await query(
      'SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2',
      [req.params.id, req.dbUser.id]
    );
    if (exists.rows.length > 0) {
      await query('DELETE FROM group_members WHERE id = $1', [exists.rows[0].id]);
      res.json({ joined: false });
    } else {
      await query(
        `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
        [req.params.id, req.dbUser.id]
      );
      res.json({ joined: true });
    }
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/groups/:id/posts', auth, loadUser, async (req, res) => {
  try {
    const member = await query(
      'SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2',
      [req.params.id, req.dbUser.id]
    );
    if (member.rows.length === 0) return res.status(403).json({ error: 'Только для участников' });
    const { text, image } = req.body;
    if (!text && !image) return res.status(400).json({ error: 'Пустой пост' });
    if (image && !isValidUrl(image)) return res.status(400).json({ error: 'URL невалиден' });
    const { rows } = await query(
      `INSERT INTO group_posts (group_id, user_id, text, image)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, req.dbUser.id, nsfwFilter(text || ''), image || '']
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/group-posts/:id/like', auth, loadUser, async (req, res) => {
  try {
    const exists = await query(
      'SELECT id FROM group_post_likes WHERE user_id = $1 AND post_id = $2',
      [req.dbUser.id, req.params.id]
    );
    if (exists.rows.length > 0) {
      await query('DELETE FROM group_post_likes WHERE id = $1', [exists.rows[0].id]);
      res.json({ liked: false });
    } else {
      await query(
        'INSERT INTO group_post_likes (user_id, post_id) VALUES ($1, $2)',
        [req.dbUser.id, req.params.id]
      );
      res.json({ liked: true });
    }
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: ФОРУМЫ
// ============================================================
app.get('/api/forums', auth, loadUser, async (req, res) => {
  const { rows } = await query(
    `SELECT f.*, u.username AS creator,
      (SELECT COUNT(*)::int FROM forum_topics WHERE forum_id = f.id) AS topics_count
     FROM forums f LEFT JOIN users u ON u.id = f.created_by
     ORDER BY f.id DESC`
  );
  res.json(rows);
});

app.post('/api/forums', auth, loadUser, async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title || title.length > 200) return res.status(400).json({ error: 'Название: 1–200' });
    const { rows } = await query(
      `INSERT INTO forums (title, description, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [nsfwFilter(title), nsfwFilter(description || ''), req.dbUser.id]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/forums/:id', auth, loadUser, async (req, res) => {
  try {
    const forum = await query('SELECT * FROM forums WHERE id = $1', [req.params.id]);
    if (forum.rows.length === 0) return res.status(404).json({ error: 'Форум не найден' });
    const topics = await query(
      `SELECT t.*, u.username AS creator,
        (SELECT COUNT(*)::int FROM forum_posts WHERE topic_id = t.id) AS posts_count
       FROM forum_topics t LEFT JOIN users u ON u.id = t.created_by
       WHERE t.forum_id = $1 ORDER BY t.id DESC`,
      [req.params.id]
    );
    res.json({ forum: forum.rows[0], topics: topics.rows });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/forums/:id/topics', auth, loadUser, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || title.length > 200) return res.status(400).json({ error: 'Тема: 1–200' });
    const { rows } = await query(
      `INSERT INTO forum_topics (forum_id, title, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, nsfwFilter(title), req.dbUser.id]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/forum-topics/:id', auth, loadUser, async (req, res) => {
  try {
    const topic = await query(
      `SELECT t.*, f.title AS forum_title, f.id AS forum_id
       FROM forum_topics t JOIN forums f ON f.id = t.forum_id WHERE t.id = $1`,
      [req.params.id]
    );
    if (topic.rows.length === 0) return res.status(404).json({ error: 'Тема не найдена' });
    const posts = await query(
      `SELECT fp.*, u.username, u.avatar, u.prefix
       FROM forum_posts fp JOIN users u ON u.id = fp.user_id
       WHERE fp.topic_id = $1 ORDER BY fp.id ASC`,
      [req.params.id]
    );
    res.json({ topic: topic.rows[0], posts: posts.rows });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/forum-topics/:id/reply', auth, loadUser, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Пустое сообщение' });
    const { rows } = await query(
      `INSERT INTO forum_posts (topic_id, user_id, text) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, req.dbUser.id, nsfwFilter(text)]
    );
    if (await incDaily(req.dbUser.id, 'daily_forum', 5)) {
      await addCoins(req.dbUser.id, 2, 'Ответ на форуме');
    }
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: МУЗЫКА
// ============================================================
app.get('/api/tracks', auth, loadUser, async (req, res) => {
  try {
    const { q, genre } = req.query;
    let sql = `SELECT t.*, u.username AS uploader,
      (SELECT COUNT(*)::int FROM track_likes WHERE track_id = t.id) AS likes_count,
      EXISTS(SELECT 1 FROM track_likes WHERE track_id = t.id AND user_id = $1) AS liked
      FROM tracks t LEFT JOIN users u ON u.id = t.uploaded_by WHERE 1=1`;
    const params = [req.dbUser.id];
    if (q) {
      params.push('%' + q + '%');
      sql += ` AND (t.title ILIKE $${params.length} OR t.artist ILIKE $${params.length})`;
    }
    if (genre) {
      params.push(genre);
      sql += ` AND t.genre = $${params.length}`;
    }
    sql += ' ORDER BY t.id DESC LIMIT 200';
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/tracks', auth, loadUser, async (req, res) => {
  try {
    const { title, artist, genre, url } = req.body;
    if (!title || !url) return res.status(400).json({ error: 'Нужны название и URL' });
    if (!isValidUrl(url)) return res.status(400).json({ error: 'URL невалиден' });
    const allowedGenres = ['Italo Disco', 'Synthwave', 'Eurodance', '80s', '90s', 'Vaporwave', 'Retro Pop'];
    const g = allowedGenres.includes(genre) ? genre : '';
    const { rows } = await query(
      `INSERT INTO tracks (title, artist, genre, url, uploaded_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [nsfwFilter(title), nsfwFilter(artist || ''), g, url, req.dbUser.id]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/tracks/:id/like', auth, loadUser, async (req, res) => {
  try {
    const exists = await query(
      'SELECT id FROM track_likes WHERE user_id = $1 AND track_id = $2',
      [req.dbUser.id, req.params.id]
    );
    if (exists.rows.length > 0) {
      await query('DELETE FROM track_likes WHERE id = $1', [exists.rows[0].id]);
      res.json({ liked: false });
    } else {
      await query(
        'INSERT INTO track_likes (user_id, track_id) VALUES ($1, $2)',
        [req.dbUser.id, req.params.id]
      );
      res.json({ liked: true });
    }
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/tracks/:id/play', auth, loadUser, async (req, res) => {
  await query('UPDATE tracks SET plays = plays + 1 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/playlists', auth, loadUser, async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, (SELECT COUNT(*)::int FROM playlist_tracks WHERE playlist_id = p.id) AS tracks_count
     FROM playlists p WHERE user_id = $1 ORDER BY p.id DESC`,
    [req.dbUser.id]
  );
  res.json(rows);
});

app.post('/api/playlists', auth, loadUser, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Нужно название' });
    const { rows } = await query(
      'INSERT INTO playlists (user_id, name) VALUES ($1, $2) RETURNING *',
      [req.dbUser.id, nsfwFilter(name)]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/playlists/:id/add/:trackId', auth, loadUser, async (req, res) => {
  try {
    const pl = await query('SELECT * FROM playlists WHERE id = $1 AND user_id = $2', [
      req.params.id, req.dbUser.id
    ]);
    if (pl.rows.length === 0) return res.status(403).json({ error: 'Нет доступа' });
    await query(
      `INSERT INTO playlist_tracks (playlist_id, track_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.params.id, req.params.trackId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.get('/api/playlists/:id', auth, loadUser, async (req, res) => {
  try {
    const pl = await query('SELECT * FROM playlists WHERE id = $1 AND user_id = $2', [
      req.params.id, req.dbUser.id
    ]);
    if (pl.rows.length === 0) return res.status(404).json({ error: 'Плейлист не найден' });
    const tracks = await query(
      `SELECT t.* FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
       WHERE pt.playlist_id = $1 ORDER BY pt.id ASC`,
      [req.params.id]
    );
    res.json({ playlist: pl.rows[0], tracks: tracks.rows });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: ИГРЫ
// ============================================================
async function listGames(table, res, userId) {
  try {
    const { rows } = await query(
      `SELECT g.*, u.username AS creator,
        (SELECT COUNT(*)::int FROM ${table === 'scratch_games' ? 'scratch_likes' : table === 'flash_games' ? 'flash_likes' : 'html_likes'}
         WHERE game_id = g.id) AS likes_count
       FROM ${table} g LEFT JOIN users u ON u.id = g.created_by
       ORDER BY g.id DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
}

app.get('/api/games/scratch', auth, loadUser, (req, res) => listGames('scratch_games', res, req.dbUser.id));
app.get('/api/games/flash', auth, loadUser, (req, res) => listGames('flash_games', res, req.dbUser.id));
app.get('/api/games/html', auth, loadUser, (req, res) => listGames('html_games', res, req.dbUser.id));

app.post('/api/games/scratch', auth, loadUser, async (req, res) => {
  const { title, embed_url } = req.body;
  if (!title || !embed_url) return res.status(400).json({ error: 'Нужны название и URL' });
  if (!isValidUrl(embed_url)) return res.status(400).json({ error: 'URL невалиден' });
  const { rows } = await query(
    'INSERT INTO scratch_games (title, embed_url, created_by) VALUES ($1, $2, $3) RETURNING *',
    [nsfwFilter(title), embed_url, req.dbUser.id]
  );
  res.json(rows[0]);
});

app.post('/api/games/flash', auth, loadUser, async (req, res) => {
  const { title, embed_url } = req.body;
  if (!title || !embed_url) return res.status(400).json({ error: 'Нужны название и URL' });
  if (!isValidUrl(embed_url)) return res.status(400).json({ error: 'URL невалиден' });
  const { rows } = await query(
    'INSERT INTO flash_games (title, embed_url, created_by) VALUES ($1, $2, $3) RETURNING *',
    [nsfwFilter(title), embed_url, req.dbUser.id]
  );
  res.json(rows[0]);
});

app.post('/api/games/html', auth, loadUser, async (req, res) => {
  const { title, code } = req.body;
  if (!title || !code) return res.status(400).json({ error: 'Нужны название и код' });
  const { rows } = await query(
    'INSERT INTO html_games (title, code, created_by) VALUES ($1, $2, $3) RETURNING *',
    [nsfwFilter(title), code, req.dbUser.id]
  );
  res.json(rows[0]);
});

app.post('/api/games/:type/:id/like', auth, loadUser, async (req, res) => {
  const type = req.params.type;
  const table = type === 'scratch' ? 'scratch_likes' : type === 'flash' ? 'flash_likes' : 'html_likes';
  const gameTable = type === 'scratch' ? 'scratch_games' : type === 'flash' ? 'flash_games' : 'html_games';
  try {
    const exists = await query(
      `SELECT id FROM ${table} WHERE user_id = $1 AND game_id = $2`,
      [req.dbUser.id, req.params.id]
    );
    if (exists.rows.length > 0) {
      await query(`DELETE FROM ${table} WHERE id = $1`, [exists.rows[0].id]);
      res.json({ liked: false });
    } else {
      await query(
        `INSERT INTO ${table} (user_id, game_id) VALUES ($1, $2)`,
        [req.dbUser.id, req.params.id]
      );
      await query(`UPDATE ${gameTable} SET plays = plays + 1 WHERE id = $1`, [req.params.id]);
      res.json({ liked: true });
    }
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: НОВОСТИ
// ============================================================
app.get('/api/news', auth, loadUser, async (req, res) => {
  const { rows } = await query(
    `SELECT n.*, u.username AS author FROM news n
     LEFT JOIN users u ON u.id = n.created_by ORDER BY n.id DESC LIMIT 100`
  );
  res.json(rows);
});

app.post('/api/news', auth, loadUser, adminOnly, async (req, res) => {
  try {
    const { title, text, image } = req.body;
    if (!title || !text) return res.status(400).json({ error: 'Нужны заголовок и текст' });
    if (image && !isValidUrl(image)) return res.status(400).json({ error: 'URL невалиден' });
    const { rows } = await query(
      `INSERT INTO news (title, text, image, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [nsfwFilter(title), nsfwFilter(text), image || '', req.dbUser.id]
    );
    await audit(req.dbUser.id, 'news_create', `Новость #${rows[0].id}: ${title}`);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: ПОИСК
// ============================================================
app.get('/api/search', auth, loadUser, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ users: [], posts: [], groups: [], forums: [] });
    const pattern = '%' + q + '%';
    const users = await query(
      `SELECT id, username, avatar FROM users WHERE username ILIKE $1 LIMIT 10`,
      [pattern]
    );
    const posts = await query(
      `SELECT p.id, p.text, u.username FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.text ILIKE $1 LIMIT 10`,
      [pattern]
    );
    const groups = await query(
      `SELECT id, name, avatar FROM groups WHERE name ILIKE $1 LIMIT 10`,
      [pattern]
    );
    const forums = await query(
      `SELECT id, title FROM forums WHERE title ILIKE $1 LIMIT 10`,
      [pattern]
    );
    res.json({
      users: users.rows,
      posts: posts.rows,
      groups: groups.rows,
      forums: forums.rows
    });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: МОНЕТЫ И МАГАЗИН
// ============================================================
app.get('/api/coins/balance', auth, loadUser, async (req, res) => {
  res.json({ balance: getBalance(req.dbUser) === Infinity ? 'Infinity' : req.dbUser.coins });
});

app.get('/api/coins/transactions', auth, loadUser, async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM coin_transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 100',
    [req.dbUser.id]
  );
  res.json(rows);
});

app.get('/api/shop/items', auth, loadUser, async (req, res) => {
  try {
    const prefixes = await query('SELECT * FROM prefixes WHERE is_active = TRUE ORDER BY price_coins ASC');
    const myPrefixes = await query(
      'SELECT prefix_id, custom_text, equipped FROM user_prefixes WHERE user_id = $1',
      [req.dbUser.id]
    );
    res.json({
      prefixes: prefixes.rows,
      myPrefixes: myPrefixes.rows,
      decorations: [
        { id: 'nick_color', name: 'Цветной ник', price: 800 },
        { id: 'animated_avatar', name: 'Анимированная аватарка', price: 1500 },
        { id: 'login_sound', name: 'Звук при входе', price: 300 },
        { id: 'avatar_frame', name: 'Рамка вокруг аватара', price: 600 },
        { id: 'custom_theme', name: 'Своя тема оформления', price: 3000 },
        { id: 'friends_slots', name: '+50 слотов для друзей', price: 1000 }
      ],
      advertising: [
        { id: 'ad_post_1d', name: 'Реклама поста на стене (1 день)', price: 1000 },
        { id: 'ad_post_3d', name: 'Реклама поста в топе (3 дня)', price: 2500 },
        { id: 'ad_group_7d', name: 'Реклама группы (7 дней)', price: 5000 }
      ]
    });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/shop/buy', auth, loadUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const { item_id, custom_text, post_id, group_id } = req.body;
    if (!item_id) return res.status(400).json({ error: 'Нет item_id' });

    let price = 0;
    let itemName = '';

    // Префиксы
    if (String(item_id).startsWith('prefix_')) {
      const pid = parseInt(item_id.replace('prefix_', ''));
      const p = await query('SELECT * FROM prefixes WHERE id = $1 AND is_active = TRUE', [pid]);
      if (p.rows.length === 0) return res.status(404).json({ error: 'Префикс не найден' });
      price = p.rows[0].price_coins;
      itemName = p.rows[0].name;
      // Проверка: уже куплен?
      const owned = await query(
        'SELECT id FROM user_prefixes WHERE user_id = $1 AND prefix_id = $2',
        [req.dbUser.id, pid]
      );
      if (owned.rows.length > 0) return res.status(400).json({ error: 'Уже куплено' });
      if (p.rows[0].type === 'custom') {
        if (!custom_text || !validatePrefix(custom_text)) {
          return res.status(400).json({ error: 'Свой префикс: до 20 символов, без NSFW' });
        }
      }
      // Покупка
      const result = await addCoins(req.dbUser.id, -price, `Покупка префикса: ${itemName}`);
      if (!result.ok) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: result.error });
      }
      await query(
        `INSERT INTO user_prefixes (user_id, prefix_id, custom_text) VALUES ($1, $2, $3)`,
        [req.dbUser.id, pid, custom_text || '']
      );
      client.release();
      return res.json({ ok: true, item: itemName, price });
    }

    // Украшения и реклама
    const catalog = {
      nick_color: { name: 'Цветной ник', price: 800 },
      animated_avatar: { name: 'Анимированная аватарка', price: 1500 },
      login_sound: { name: 'Звук при входе', price: 300 },
      avatar_frame: { name: 'Рамка вокруг аватара', price: 600 },
      custom_theme: { name: 'Своя тема оформления', price: 3000 },
      friends_slots: { name: '+50 слотов для друзей', price: 1000 },
      ad_post_1d: { name: 'Реклама поста на стене (1 день)', price: 1000 },
      ad_post_3d: { name: 'Реклама поста в топе (3 дня)', price: 2500 },
      ad_group_7d: { name: 'Реклама группы (7 дней)', price: 5000 }
    };
    if (!catalog[item_id]) return res.status(404).json({ error: 'Товар не найден' });
    price = catalog[item_id].price;
    itemName = catalog[item_id].name;

    const result = await addCoins(req.dbUser.id, -price, `Покупка: ${itemName}`);
    if (!result.ok) {
      client.release();
      return res.status(400).json({ error: result.error });
    }

    // Выдача товара
    if (item_id === 'friends_slots') {
      await query('UPDATE users SET friends_slots = friends_slots + 50 WHERE id = $1', [req.dbUser.id]);
    } else if (item_id === 'ad_post_1d' && post_id) {
      await query(
        `UPDATE posts SET promoted_until = NOW() + INTERVAL '1 day'
         WHERE id = $1 AND user_id = $2`,
        [post_id, req.dbUser.id]
      );
    } else if (item_id === 'ad_post_3d' && post_id) {
      await query(
        `UPDATE posts SET promoted_until = NOW() + INTERVAL '3 days'
         WHERE id = $1 AND user_id = $2`,
        [post_id, req.dbUser.id]
      );
    } else if (item_id === 'ad_group_7d' && group_id) {
      await audit(req.dbUser.id, 'group_ad', `Группа #${group_id} рекламируется 7 дней`);
    }
    client.release();
    res.json({ ok: true, item: itemName, price });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    client.release();
    console.error(e);
    res.status(500).json({ error: 'Ошибка покупки' });
  }
});

app.get('/api/shop/my-purchases', auth, loadUser, async (req, res) => {
  const prefixes = await query(
    `SELECT up.*, p.name, p.price_coins FROM user_prefixes up
     JOIN prefixes p ON p.id = up.prefix_id WHERE up.user_id = $1 ORDER BY up.id DESC`,
    [req.dbUser.id]
  );
  res.json({ prefixes: prefixes.rows });
});

app.post('/api/shop/equip-prefix/:id', auth, loadUser, async (req, res) => {
  try {
    const up = await query(
      'SELECT * FROM user_prefixes WHERE id = $1 AND user_id = $2',
      [req.params.id, req.dbUser.id]
    );
    if (up.rows.length === 0) return res.status(404).json({ error: 'Нет такого префикса' });
    await query('UPDATE user_prefixes SET equipped = FALSE WHERE user_id = $1', [req.dbUser.id]);
    await query('UPDATE user_prefixes SET equipped = TRUE WHERE id = $1', [req.params.id]);
    const p = await query('SELECT name FROM prefixes WHERE id = $1', [up.rows[0].prefix_id]);
    const text = up.rows[0].custom_text || (p.rows[0] && p.rows[0].name) || '';
    await query('UPDATE users SET prefix = $1 WHERE id = $2', [text, req.dbUser.id]);
    res.json({ ok: true, prefix: text });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: КОНКУРСЫ
// ============================================================
app.get('/api/contests', auth, loadUser, async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, u.username AS creator,
      (SELECT COUNT(*)::int FROM contest_entries WHERE contest_id = c.id) AS entries_count
     FROM contests c LEFT JOIN users u ON u.id = c.created_by
     ORDER BY c.id DESC LIMIT 100`
  );
  res.json(rows);
});

app.post('/api/contests', auth, loadUser, adminOnly, async (req, res) => {
  try {
    const { title, description, prize_coins, deadline } = req.body;
    if (!title || !prize_coins) return res.status(400).json({ error: 'Нужны title и prize_coins' });
    if (prize_coins <= 0 || prize_coins > 1000000) return res.status(400).json({ error: 'Приз: 1–1 000 000' });
    const { rows } = await query(
      `INSERT INTO contests (title, description, prize_coins, deadline, created_by, status)
       VALUES ($1, $2, $3, $4, $5, 'active') RETURNING *`,
      [nsfwFilter(title), nsfwFilter(description || ''), prize_coins, deadline || null, req.dbUser.id]
    );
    await audit(req.dbUser.id, 'contest_create', `Конкурс #${rows[0].id}`);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/contests/:id/enter', auth, loadUser, async (req, res) => {
  try {
    const c = await query('SELECT * FROM contests WHERE id = $1 AND status = $2', [req.params.id, 'active']);
    if (c.rows.length === 0) return res.status(400).json({ error: 'Конкурс не активен' });
    const { entry_text, entry_url } = req.body;
    if (entry_url && !isValidUrl(entry_url)) return res.status(400).json({ error: 'URL невалиден' });
    const exists = await query(
      'SELECT id FROM contest_entries WHERE contest_id = $1 AND user_id = $2',
      [req.params.id, req.dbUser.id]
    );
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Вы уже подали заявку' });
    const { rows } = await query(
      `INSERT INTO contest_entries (contest_id, user_id, entry_text, entry_url)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, req.dbUser.id, nsfwFilter(entry_text || ''), entry_url || '']
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/contests/:id/finish', auth, loadUser, adminOnly, async (req, res) => {
  try {
    const { winner_id } = req.body;
    const c = await query('SELECT * FROM contests WHERE id = $1', [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Конкурс не найден' });
    if (c.rows[0].status === 'finished') return res.status(400).json({ error: 'Уже завершён' });
    if (!winner_id) return res.status(400).json({ error: 'Нужен winner_id' });
    await query(
      `UPDATE contests SET status = 'finished', winner_id = $1 WHERE id = $2`,
      [winner_id, req.params.id]
    );
    const result = await addCoins(winner_id, c.rows[0].prize_coins, `Победа в конкурсе #${req.params.id}`);
    await audit(req.dbUser.id, 'contest_finish', `Конкурс #${req.params.id}, победитель #${winner_id}`);
    res.json({ ok: true, balance: result.balance });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// API: АДМИН-ПАНЕЛЬ
// ============================================================
app.get('/api/admin/stats', auth, loadUser, adminOnly, async (req, res) => {
  const users = await query('SELECT COUNT(*)::int AS c FROM users');
  const posts = await query('SELECT COUNT(*)::int AS c FROM posts');
  const groups = await query('SELECT COUNT(*)::int AS c FROM groups');
  const forums = await query('SELECT COUNT(*)::int AS c FROM forums');
  const messages = await query('SELECT COUNT(*)::int AS c FROM messages');
  const tracks = await query('SELECT COUNT(*)::int AS c FROM tracks');
  const coins = await query('SELECT COALESCE(SUM(amount),0)::int AS s FROM coin_transactions');
  res.json({
    users: users.rows[0].c,
    posts: posts.rows[0].c,
    groups: groups.rows[0].c,
    forums: forums.rows[0].c,
    messages: messages.rows[0].c,
    tracks: tracks.rows[0].c,
    coin_transactions_total: coins.rows[0].s
  });
});

app.get('/api/admin/users', auth, loadUser, adminOnly, async (req, res) => {
  const { rows } = await query(
    `SELECT id, username, role, banned, coins, created_at FROM users ORDER BY id DESC LIMIT 500`
  );
  res.json(rows);
});

app.post('/api/admin/ban/:id', auth, loadUser, adminOnly, async (req, res) => {
  try {
    const { ban } = req.body;
    await query('UPDATE users SET banned = $1 WHERE id = $2', [!!ban, req.params.id]);
    await audit(req.dbUser.id, ban ? 'ban' : 'unban', `Пользователь #${req.params.id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.delete('/api/admin/user/:id', auth, loadUser, adminOnly, async (req, res) => {
  try {
    if (OWNER_USERNAMES.length > 0) {
      const u = await query('SELECT username FROM users WHERE id = $1', [req.params.id]);
      if (u.rows.length > 0 && OWNER_USERNAMES.includes(u.rows[0].username)) {
        return res.status(403).json({ error: 'Нельзя удалить владельца' });
      }
    }
    await query('DELETE FROM users WHERE id = $1', [req.params.id]);
    await audit(req.dbUser.id, 'user_delete', `Пользователь #${req.params.id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.post('/api/admin/reset-password/:id', auth, loadUser, adminOnly, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Мин 4 символа' });
    const hash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
    const admin = req.dbUser;
    const sys = await query(
      `INSERT INTO messages (from_id, to_id, text) VALUES ($1, $2, $3) RETURNING *`,
      [admin.id, req.params.id, `Ваш новый пароль: ${newPassword} (сообщение от администратора)`]
    );
    await audit(admin.id, 'password_reset', `Пользователь #${req.params.id}`);
    res.json({ ok: true, message_id: sys.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

app.delete('/api/admin/group/:id', auth, loadUser, adminOnly, async (req, res) => {
  await query('DELETE FROM groups WHERE id = $1', [req.params.id]);
  await audit(req.dbUser.id, 'group_delete', `Группа #${req.params.id}`);
  res.json({ ok: true });
});

app.delete('/api/admin/forum/:id', auth, loadUser, adminOnly, async (req, res) => {
  await query('DELETE FROM forums WHERE id = $1', [req.params.id]);
  await audit(req.dbUser.id, 'forum_delete', `Форум #${req.params.id}`);
  res.json({ ok: true });
});

app.get('/api/admin/audit', auth, loadUser, adminOnly, async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, u.username AS admin FROM audit_log a
     LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT 200`
  );
  res.json(rows);
});

app.post('/api/admin/give-coins/:id', auth, loadUser, adminOnly, async (req, res) => {
  try {
    const { amount, reason } = req.body;
    const amt = parseInt(amount);
    if (!amt || amt === 0) return res.status(400).json({ error: 'Нужна сумма' });
    const result = await addCoins(parseInt(req.params.id), amt, reason || 'Начисление админом');
    if (!result.ok) return res.status(400).json({ error: result.error });
    await audit(req.dbUser.id, 'give_coins', `Пользователю #${req.params.id}: ${amt} RC`);
    if (amt > 0) {
      await query(
        `INSERT INTO messages (from_id, to_id, text) VALUES ($1, $2, $3)`,
        [req.dbUser.id, req.params.id, `Вам начислено ${amt} RC (${reason || 'бонус'})`]
      );
    }
    res.json({ ok: true, balance: result.balance });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================================
// SOCKET.IO: онлайн, чат, звонки
// ============================================================
const onlineUsers = new Map(); // userId -> socketId

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('Нет токена'));
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = payload;
    next();
  } catch (e) {
    next(new Error('Невалидный токен'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  onlineUsers.set(userId, socket.id);
  io.emit('online', Array.from(onlineUsers.keys()));

  socket.on('typing', ({ toId }) => {
    const sid = onlineUsers.get(toId);
    if (sid) io.to(sid).emit('typing', { fromId: userId });
  });

  // WebRTC signaling
  socket.on('call:offer', ({ toId, offer, isVideo }) => {
    const sid = onlineUsers.get(toId);
    if (sid) io.to(sid).emit('call:offer', { fromId: userId, offer, isVideo });
  });
  socket.on('call:answer', ({ toId, answer }) => {
    const sid = onlineUsers.get(toId);
    if (sid) io.to(sid).emit('call:answer', { fromId: userId, answer });
  });
  socket.on('call:ice', ({ toId, candidate }) => {
    const sid = onlineUsers.get(toId);
    if (sid) io.to(sid).emit('call:ice', { fromId: userId, candidate });
  });
  socket.on('call:end', ({ toId }) => {
    const sid = onlineUsers.get(toId);
    if (sid) io.to(sid).emit('call:end', { fromId: userId });
  });
  socket.on('call:reject', ({ toId }) => {
    const sid = onlineUsers.get(toId);
    if (sid) io.to(sid).emit('call:reject', { fromId: userId });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    io.emit('online', Array.from(onlineUsers.keys()));
  });
});

// ============================================================
// 404 + ERROR
// ============================================================
app.use('/api/', (req, res) => {
  res.status(404).json({ error: 'API не найден' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// ЗАПУСК
// ============================================================
initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`РетроСеть 2010 запущена на порту ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Ошибка инициализации БД:', err);
    process.exit(1);
  });
