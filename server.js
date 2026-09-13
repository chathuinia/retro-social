// server.js — соцсеть + мессенджер + форумы (финальная версия)
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

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'retro-2010-secret';

// === БАЗА ===
// Убираем ?sslmode=require из строки, чтобы не было двойного SSL-конфликта
let dbUrl = process.env.DATABASE_URL || '';
dbUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');

console.log('=== DB CONFIG ===');
console.log('DATABASE_URL задан:', !!process.env.DATABASE_URL);
console.log('Длина строки:', dbUrl.length);
console.log('Начало:', dbUrl.slice(0, 40) + '...');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('POOL ERROR:', err.message);
});

// === ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ ===
async function initDB() {
  console.log('Инициализация таблиц...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      avatar TEXT DEFAULT '',
      status VARCHAR(255) DEFAULT 'Всем привет! Я в сети!',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      image TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS likes (
      id SERIAL PRIMARY KEY,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS friendships (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      friend_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending',
      UNIQUE(user_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      to_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
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
  `);
  console.log('✅ Таблицы готовы');
}

// === АУТЕНТИФИКАЦИЯ ===
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

// === ДИАГНОСТИКА ===
app.get('/api/debug', async (req, res) => {
  const info = {
    hasDbUrl: !!process.env.DATABASE_URL,
    dbUrlLength: dbUrl.length,
    dbUrlStart: dbUrl.slice(0, 40) + '...',
    hasJwt: !!process.env.JWT_SECRET,
    dbConnection: null,
    tables: null,
    error: null
  };
  try {
    await pool.query('SELECT 1');
    info.dbConnection = 'OK';
  } catch (e) {
    info.dbConnection = 'FAIL';
    info.error = e.message;
    return res.json(info);
  }
  try {
    const r = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' ORDER BY table_name
    `);
    info.tables = r.rows.map(x => x.table_name);
  } catch (e) {
    info.tables = 'ERROR: ' + e.message;
  }
  res.json(info);
});

// === РЕГИСТРАЦИЯ ===
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните поля' });

  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.error('DB CONNECTION ERROR:', e.message);
    return res.status(500).json({ error: 'Нет связи с БД: ' + e.message });
  }

  try {
    await pool.query('SELECT id FROM users LIMIT 1');
  } catch (e) {
    console.error('TABLE ERROR:', e.message);
    return res.status(500).json({ error: 'Таблица users не готова: ' + e.message });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Логин занят' });

    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users(username, password) VALUES($1,$2) RETURNING id, username',
      [username, hash]
    );
    const token = jwt.sign({ id: r.rows[0].id, username }, JWT_SECRET);
    console.log('✅ Новый пользователь:', username);
    res.json({ token, user: r.rows[0] });
  } catch (e) {
    console.error('REGISTER ERROR:', e.message);
    res.status(500).json({ error: 'Ошибка регистрации: ' + e.message });
  }
});

// === ВХОД ===
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (!r.rows[0]) return res.status(400).json({ error: 'Нет такого пользователя' });
    const ok = await bcrypt.compare(password, r.rows[0].password);
    if (!ok) return res.status(400).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ id: r.rows[0].id, username }, JWT_SECRET);
    res.json({ token, user: { id: r.rows[0].id, username } });
  } catch (e) {
    console.error('LOGIN ERROR:', e.message);
    res.status(500).json({ error: 'Ошибка сервера: ' + e.message });
  }
});

// === ПОСТЫ ===
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
  } catch (e) {
    console.error('POSTS ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/posts', auth, async (req, res) => {
  const { content, image } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Пустой пост' });
  try {
    const r = await pool.query(
      'INSERT INTO posts(user_id, content, image) VALUES($1,$2,$3) RETURNING *',
      [req.user.id, content, image || '']
    );
    io.emit('new_post');
    res.json(r.rows[0]);
  } catch (e) {
    console.error('CREATE POST ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/like/:id', auth, async (req, res) => {
  const postId = req.params.id;
  try {
    const exists = await pool.query(
      'SELECT 1 FROM likes WHERE post_id=$1 AND user_id=$2',
      [postId, req.user.id]
    );
    if (exists.rows[0]) {
      await pool.query('DELETE FROM likes WHERE post_id=$1 AND user_id=$2', [postId, req.user.id]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO likes(post_id, user_id) VALUES($1,$2)', [postId, req.user.id]);
      res.json({ liked: true });
    }
  } catch (e) {
    console.error('LIKE ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// === ПОЛЬЗОВАТЕЛИ ===
app.get('/api/users', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, username, avatar, status FROM users WHERE id != $1 LIMIT 100',
      [req.user.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, username, avatar, status FROM users WHERE id=$1', [req.user.id]);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/me', auth, async (req, res) => {
  const { status, avatar } = req.body;
  try {
    await pool.query('UPDATE users SET status=$1, avatar=$2 WHERE id=$3',
      [status || '', avatar || '', req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === СООБЩЕНИЯ ===
app.get('/api/messages/:userId', auth, async (req, res) => {
  const other = req.params.userId;
  try {
    const r = await pool.query(`
      SELECT * FROM messages
      WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)
      ORDER BY created_at ASC LIMIT 200
    `, [req.user.id, other]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/messages/:userId', auth, async (req, res) => {
  const to = req.params.userId;
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Пусто' });
  try {
    const r = await pool.query(
      'INSERT INTO messages(from_id, to_id, content) VALUES($1,$2,$3) RETURNING *',
      [req.user.id, to, content]
    );
    io.to('user_' + to).emit('new_message', { ...r.rows[0], from_username: req.user.username });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === ФОРУМЫ ===
app.get('/api/forums', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT f.*, u.username AS author,
        (SELECT COUNT(*) FROM forum_topics WHERE forum_id=f.id) AS topics_count,
        (SELECT COUNT(*) FROM forum_posts fp
          JOIN forum_topics ft ON ft.id=fp.topic_id
          WHERE ft.forum_id=f.id) AS posts_count
      FROM forums f
      LEFT JOIN users u ON u.id=f.created_by
      ORDER BY f.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/forums', auth, async (req, res) => {
  const { title, description } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Введите название' });
  try {
    const r = await pool.query(
      'INSERT INTO forums(title, description, created_by) VALUES($1,$2,$3) RETURNING *',
      [title, description || '', req.user.id]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/forums/:id', auth, async (req, res) => {
  try {
    const f = await pool.query(`
      SELECT f.*, u.username AS author FROM forums f
      LEFT JOIN users u ON u.id=f.created_by WHERE f.id=$1
    `, [req.params.id]);
    if (!f.rows[0]) return res.status(404).json({ error: 'Форум не найден' });

    const topics = await pool.query(`
      SELECT t.*, u.username AS author,
        (SELECT COUNT(*) FROM forum_posts WHERE topic_id=t.id) AS posts_count
      FROM forum_topics t
      LEFT JOIN users u ON u.id=t.user_id
      WHERE t.forum_id=$1
      ORDER BY t.created_at DESC
    `, [req.params.id]);

    res.json({ forum: f.rows[0], topics: topics.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/forums/:id/topics', auth, async (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Введите название темы' });
  try {
    const r = await pool.query(
      'INSERT INTO forum_topics(forum_id, user_id, title) VALUES($1,$2,$3) RETURNING *',
      [req.params.id, req.user.id, title]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/topics/:id', auth, async (req, res) => {
  try {
    const t = await pool.query(`
      SELECT t.*, u.username AS author, f.title AS forum_title, f.id AS forum_id
      FROM forum_topics t
      LEFT JOIN users u ON u.id=t.user_id
      LEFT JOIN forums f ON f.id=t.forum_id
      WHERE t.id=$1
    `, [req.params.id]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Тема не найдена' });

    const posts = await pool.query(`
      SELECT fp.*, u.username, u.avatar
      FROM forum_posts fp
      LEFT JOIN users u ON u.id=fp.user_id
      WHERE fp.topic_id=$1
      ORDER BY fp.created_at ASC
    `, [req.params.id]);

    res.json({ topic: t.rows[0], posts: posts.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/topics/:id/posts', auth, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Пустое сообщение' });
  try {
    const r = await pool.query(
      'INSERT INTO forum_posts(topic_id, user_id, content) VALUES($1,$2,$3) RETURNING *',
      [req.params.id, req.user.id, content]
    );
    const full = await pool.query(`
      SELECT fp.*, u.username, u.avatar FROM forum_posts fp
      LEFT JOIN users u ON u.id=fp.user_id WHERE fp.id=$1
    `, [r.rows[0].id]);
    io.emit('new_forum_post', { topic_id: Number(req.params.id) });
    res.json(full.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === SOCKET.IO ===
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
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
});

// === ЗАПУСК ===
const PORT = process.env.PORT || 3000;

// Сначала инициализируем БД, ПОТОМ стартуем сервер
initDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🚀 Сервер запущен на порту ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ FATAL: Не удалось инициализировать БД');
    console.error(err);
    // Всё равно стартуем, чтобы отдать /api/debug
    server.listen(PORT, () => {
      console.log(`⚠️  Сервер запущен БЕЗ БД на порту ${PORT}`);
    });
  });
