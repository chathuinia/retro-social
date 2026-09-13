// server.js — бэкенд соцсети в стиле 2010
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

// === БАЗА ДАННЫХ ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const JWT_SECRET = process.env.JWT_SECRET || 'retro-2010-secret';

// === ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ ===
async function initDB() {
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
  `);
  console.log('✅ Таблицы готовы');
}
initDB().catch(e => console.error('DB error:', e));

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

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните поля' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users(username, password) VALUES($1,$2) RETURNING id, username',
      [username, hash]
    );
    const token = jwt.sign({ id: r.rows[0].id, username }, JWT_SECRET);
    res.json({ token, user: r.rows[0] });
  } catch (e) {
    res.status(400).json({ error: 'Логин занят' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  if (!r.rows[0]) return res.status(400).json({ error: 'Нет такого пользователя' });
  const ok = await bcrypt.compare(password, r.rows[0].password);
  if (!ok) return res.status(400).json({ error: 'Неверный пароль' });
  const token = jwt.sign({ id: r.rows[0].id, username }, JWT_SECRET);
  res.json({ token, user: { id: r.rows[0].id, username } });
});

// === ПОСТЫ ===
app.get('/api/posts', auth, async (req, res) => {
  const r = await pool.query(`
    SELECT p.*, u.username, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS likes,
      EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=$1) AS liked
    FROM posts p JOIN users u ON u.id=p.user_id
    ORDER BY p.created_at DESC LIMIT 50
  `, [req.user.id]);
  res.json(r.rows);
});

app.post('/api/posts', auth, async (req, res) => {
  const { content, image } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Пустой пост' });
  const r = await pool.query(
    'INSERT INTO posts(user_id, content, image) VALUES($1,$2,$3) RETURNING *',
    [req.user.id, content, image || '']
  );
  io.emit('new_post');
  res.json(r.rows[0]);
});

app.post('/api/like/:id', auth, async (req, res) => {
  const postId = req.params.id;
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
});

// === ПОЛЬЗОВАТЕЛИ / ДРУЗЬЯ ===
app.get('/api/users', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT id, username, avatar, status FROM users WHERE id != $1 LIMIT 100',
    [req.user.id]
  );
  res.json(r.rows);
});

app.get('/api/me', auth, async (req, res) => {
  const r = await pool.query('SELECT id, username, avatar, status FROM users WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
});

app.put('/api/me', auth, async (req, res) => {
  const { status, avatar } = req.body;
  await pool.query('UPDATE users SET status=$1, avatar=$2 WHERE id=$3',
    [status || '', avatar || '', req.user.id]);
  res.json({ ok: true });
});

// === СООБЩЕНИЯ ===
app.get('/api/messages/:userId', auth, async (req, res) => {
  const other = req.params.userId;
  const r = await pool.query(`
    SELECT * FROM messages
    WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)
    ORDER BY created_at ASC LIMIT 200
  `, [req.user.id, other]);
  res.json(r.rows);
});

app.post('/api/messages/:userId', auth, async (req, res) => {
  const to = req.params.userId;
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Пусто' });
  const r = await pool.query(
    'INSERT INTO messages(from_id, to_id, content) VALUES($1,$2,$3) RETURNING *',
    [req.user.id, to, content]
  );
  io.to('user_' + to).emit('new_message', { ...r.rows[0], from_username: req.user.username });
  res.json(r.rows[0]);
});

// === SOCKET.IO (онлайн + сообщения) ===
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
server.listen(PORT, () => console.log('🚀 Соцсеть на порту', PORT));
