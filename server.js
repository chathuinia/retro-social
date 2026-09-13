// server.js — соцсеть + форумы + группы + поиск + новости + админка + звонки + вложения
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

app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

// === ИНИЦИАЛИЗАЦИЯ ===
async function initDB() {
  console.log('Инициализация таблиц...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      avatar TEXT DEFAULT '',
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
  `);

  const alterQueries = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE posts ADD COLUMN IF NOT EXISTS video TEXT DEFAULT ''`,
    `ALTER TABLE posts ADD COLUMN IF NOT EXISTS gif TEXT DEFAULT ''`
  ];
  for (const q of alterQueries) {
    try { await pool.query(q); } catch (e) {}
  }

  try {
    await pool.query(`UPDATE users SET role='admin' WHERE username=$1`, [OWNER_USERNAME]);
  } catch (e) {}

  console.log('Таблицы готовы');
}

// === AUTH ===
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

// === РЕГИСТРАЦИЯ / ВХОД ===
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните поля' });
  if (username.length < 3) return res.status(400).json({ error: 'Логин минимум 3 символа' });
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
    console.log('Новый пользователь:', username, '(' + role + ')');
    res.json({ token, user: r.rows[0] });
  } catch (e) {
    console.error('REGISTER ERROR:', e.message);
    res.status(500).json({ error: 'Ошибка регистрации: ' + e.message });
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

// === ME ===
app.get('/api/me', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, username, avatar, status, role FROM users WHERE id=$1', [req.user.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/me', auth, async (req, res) => {
  const { status, avatar } = req.body;
  try {
    await pool.query('UPDATE users SET status=$1, avatar=$2 WHERE id=$3', [status || '', avatar || '', req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, username, avatar, status FROM users WHERE id != $1 AND banned=FALSE LIMIT 100', [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts', auth, async (req, res) => {
  const { content, image, video, gif } = req.body;
  if (!content?.trim() && !image && !video && !gif) return res.status(400).json({ error: 'Пустой пост' });
  try {
    const r = await pool.query(
      'INSERT INTO posts(user_id, content, image, video, gif) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, content || '', image || '', video || '', gif || '']
    );
    io.emit('new_post');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/posts/:id', auth, async (req, res) => {
  try {
    const p = await pool.query('SELECT user_id FROM posts WHERE id=$1', [req.params.id]);
    if (!p.rows[0]) return res.status(404).json({ error: 'Нет поста' });
    const me = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]);
    if (p.rows[0].user_id !== req.user.id && me.rows[0]?.role !== 'admin') {
      return res.status(403).json({ error: 'Не ваш пост' });
    }
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

// === СООБЩЕНИЯ ===
app.get('/api/messages/:userId', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT m.*,
        COALESCE(
          (SELECT json_agg(json_build_object('type', media_type, 'url', url, 'filename', filename))
           FROM message_media WHERE message_id=m.id),
          '[]'::json
        ) AS media
      FROM messages m
      WHERE (m.from_id=$1 AND m.to_id=$2) OR (m.from_id=$2 AND m.to_id=$1)
      ORDER BY m.created_at ASC LIMIT 200
    `, [req.user.id, req.params.userId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/:userId', auth, async (req, res) => {
  const { content, media } = req.body;
  if (!content?.trim() && (!media || !media.length)) {
    return res.status(400).json({ error: 'Пустое сообщение' });
  }
  try {
    const r = await pool.query(
      'INSERT INTO messages(from_id, to_id, content) VALUES($1,$2,$3) RETURNING *',
      [req.user.id, req.params.userId, content || '']
    );
    const msg = r.rows[0];

    if (media && media.length) {
      for (const m of media) {
        await pool.query(
          'INSERT INTO message_media(message_id, media_type, url, filename) VALUES($1,$2,$3,$4)',
          [msg.id, m.type || 'image', m.url, m.filename || '']
        );
      }
    }

    const full = await pool.query(`
      SELECT m.*,
        COALESCE(
          (SELECT json_agg(json_build_object('type', media_type, 'url', url, 'filename', filename))
           FROM message_media WHERE message_id=m.id),
          '[]'::json
        ) AS media
      FROM messages m WHERE m.id=$1
    `, [msg.id]);

    io.to('user_' + req.params.userId).emit('new_message', {
      ...full.rows[0],
      from_username: req.user.username
    });
    res.json(full.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === ФОРУМЫ ===
app.get('/api/forums', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT f.*, u.username AS author,
        (SELECT COUNT(*) FROM forum_topics WHERE forum_id=f.id) AS topics_count,
        (SELECT COUNT(*) FROM forum_posts fp JOIN forum_topics ft ON ft.id=fp.topic_id WHERE ft.forum_id=f.id) AS posts_count
      FROM forums f LEFT JOIN users u ON u.id=f.created_by
      ORDER BY f.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/forums', auth, async (req, res) => {
  const { title, description } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Введите название' });
  try {
    const r = await pool.query('INSERT INTO forums(title, description, created_by) VALUES($1,$2,$3) RETURNING *',
      [title, description || '', req.user.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/forums/:id', auth, async (req, res) => {
  try {
    const f = await pool.query(`SELECT f.*, u.username AS author FROM forums f LEFT JOIN users u ON u.id=f.created_by WHERE f.id=$1`, [req.params.id]);
    if (!f.rows[0]) return res.status(404).json({ error: 'Форум не найден' });
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
      FROM forum_topics t
      LEFT JOIN users u ON u.id=t.user_id
      LEFT JOIN forums f ON f.id=t.forum_id
      WHERE t.id=$1
    `, [req.params.id]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Тема не найдена' });
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
  try {
    const r = await pool.query('INSERT INTO forum_posts(topic_id, user_id, content) VALUES($1,$2,$3) RETURNING *',
      [req.params.id, req.user.id, content]);
    const full = await pool.query(`SELECT fp.*, u.username, u.avatar FROM forum_posts fp LEFT JOIN users u ON u.id=fp.user_id WHERE fp.id=$1`, [r.rows[0].id]);
    io.emit('new_forum_post', { topic_id: Number(req.params.id) });
    res.json(full.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === ГРУППЫ ===
app.get('/api/groups', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT g.*, u.username AS author,
        (SELECT COUNT(*) FROM group_members WHERE group_id=g.id) AS members_count,
        EXISTS(SELECT 1 FROM group_members WHERE group_id=g.id AND user_id=$1) AS is_member
      FROM groups g LEFT JOIN users u ON u.id=g.created_by
      ORDER BY g.created_at DESC
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups', auth, async (req, res) => {
  const { name, description, avatar } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Введите название' });
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
    if (!g.rows[0]) return res.status(404).json({ error: 'Группа не найдена' });
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
  const { content, image, video, gif } = req.body;
  if (!content?.trim() && !image && !video && !gif) return res.status(400).json({ error: 'Пустой пост' });
  try {
    const member = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!member.rows[0]) return res.status(403).json({ error: 'Вы не в группе' });
    const r = await pool.query('INSERT INTO group_posts(group_id, user_id, content, image, video, gif) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.id, req.user.id, content || '', image || '', video || '', gif || '']);
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

// === НОВОСТИ ===
app.get('/api/news', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM news ORDER BY created_at DESC LIMIT 50');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/news', auth, adminOnly, async (req, res) => {
  const { title, content, image } = req.body;
  if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: 'Заполните поля' });
  try {
    const r = await pool.query('INSERT INTO news(title, content, image) VALUES($1,$2,$3) RETURNING *',
      [title, content, image || '']);
    io.emit('new_news');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/news/:id', auth, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM news WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === ПАРТИИ / ГОЛОСОВАНИЕ ===
app.get('/api/parties', auth, async (req, res) => {
  try {
    const parties = await pool.query(`
      SELECT p.*,
        (SELECT COUNT(*) FROM votes WHERE party_id=p.id) AS votes
      FROM parties p ORDER BY p.created_at ASC
    `);
    const myVote = await pool.query('SELECT party_id FROM votes WHERE user_id=$1', [req.user.id]);
    res.json({
      parties: parties.rows,
      myVote: myVote.rows[0]?.party_id || null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/parties', auth, adminOnly, async (req, res) => {
  const { name, description, logo } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Введите название' });
  try {
    const r = await pool.query('INSERT INTO parties(name, description, logo) VALUES($1,$2,$3) RETURNING *',
      [name, description || '', logo || '']);
    io.emit('new_vote');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/parties/:id', auth, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM parties WHERE id=$1', [req.params.id]);
    io.emit('new_vote');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/parties/vote/:id', auth, async (req, res) => {
  try {
    const existing = await pool.query('SELECT party_id FROM votes WHERE user_id=$1', [req.user.id]);
    if (existing.rows[0]) {
      return res.status(400).json({ error: 'Вы уже голосовали' });
    }
    await pool.query('INSERT INTO votes(user_id, party_id) VALUES($1,$2)', [req.user.id, req.params.id]);
    io.emit('new_vote');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === ПОИСК ===
app.get('/api/search', auth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ users: [], posts: [], groups: [], forums: [] });
  const pattern = '%' + q.toLowerCase() + '%';

  try {
    const users = await pool.query(`SELECT id, username, avatar, status FROM users WHERE LOWER(username) LIKE $1 AND id != $2 AND banned=FALSE LIMIT 20`, [pattern, req.user.id]);
    const posts = await pool.query(`SELECT p.*, u.username, u.avatar, (SELECT COUNT(*) FROM likes WHERE post_id=p.id) AS likes FROM posts p JOIN users u ON u.id=p.user_id WHERE LOWER(p.content) LIKE $1 ORDER BY p.created_at DESC LIMIT 20`, [pattern]);
    const groups = await pool.query(`SELECT g.*, (SELECT COUNT(*) FROM group_members WHERE group_id=g.id) AS members_count FROM groups g WHERE LOWER(g.name) LIKE $1 OR LOWER(g.description) LIKE $1 ORDER BY g.created_at DESC LIMIT 20`, [pattern]);
    const forums = await pool.query(`SELECT f.*, (SELECT COUNT(*) FROM forum_topics WHERE forum_id=f.id) AS topics_count FROM forums f WHERE LOWER(f.title) LIKE $1 OR LOWER(f.description) LIKE $1 ORDER BY f.created_at DESC LIMIT 20`, [pattern]);

    res.json({ users: users.rows, posts: posts.rows, groups: groups.rows, forums: forums.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === АДМИНКА ===
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
    if (!r.rows[0]) return res.status(404).json({ error: 'Нет юзера' });
    await pool.query('UPDATE users SET banned=$1 WHERE id=$2', [!r.rows[0].banned, req.params.id]);
    res.json({ banned: !r.rows[0].banned });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Себя нельзя' });
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
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

// === SOCKET ===
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    next();
  } catch { next(new Error('unauthorized')); }
});

const online = new Set();
const userSockets = new Map();

io.on('connection', (socket) => {
  online.add(socket.user.id);
  socket.join('user_' + socket.user.id);
  userSockets.set(socket.user.id, socket.id);
  io.emit('online', Array.from(online));

  socket.on('disconnect', () => {
    online.delete(socket.user.id);
    userSockets.delete(socket.user.id);
    io.emit('online', Array.from(online));
  });

  // === ЗВОНКИ (сигналинг) ===
  socket.on('call:start', ({ to, type }) => {
    io.to('user_' + to).emit('call:incoming', {
      from: socket.user.id,
      fromName: socket.user.username,
      type
    });
  });

  socket.on('call:accept', ({ to }) => {
    io.to('user_' + to).emit('call:accepted', { from: socket.user.id });
  });

  socket.on('call:reject', ({ to }) => {
    io.to('user_' + to).emit('call:rejected', { from: socket.user.id });
  });

  socket.on('call:end', ({ to }) => {
    io.to('user_' + to).emit('call:ended', { from: socket.user.id });
  });

  socket.on('webrtc:offer', ({ to, offer }) => {
    io.to('user_' + to).emit('webrtc:offer', { from: socket.user.id, offer });
  });

  socket.on('webrtc:answer', ({ to, answer }) => {
    io.to('user_' + to).emit('webrtc:answer', { from: socket.user.id, answer });
  });

  socket.on('webrtc:ice', ({ to, candidate }) => {
    io.to('user_' + to).emit('webrtc:ice', { from: socket.user.id, candidate });
  });
});

// === ЗАПУСК ===
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => server.listen(PORT, () => console.log(`Сервер на порту ${PORT}`)))
  .catch((err) => {
    console.error('FATAL:', err);
    server.listen(PORT, () => console.log(`Без БД на порту ${PORT}`));
  });
