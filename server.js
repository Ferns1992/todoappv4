const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const PORT = Number(process.env.PORT || 3060);
const DB_DIR = process.env.DB_DIR
  ? path.resolve(process.env.DB_DIR)
  : path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'todos.db');
const LEGACY_DB_FILE = path.join(__dirname, 'todos.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

let db;
const sessions = new Map();

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

function normalizeTodo(row) {
  return {
    id: Number(row.id),
    text: row.text,
    completed: Boolean(row.completed),
    priority: row.priority || 'medium',
    category: row.category || 'General',
    dueDate: row.due_date || '',
    notes: row.notes || '',
    ownerId: Number(row.user_id),
    ownerName: row.owner_name || 'Unknown',
    createdAt: row.created_at,
  };
}

function runQuery(query, params = []) {
  db.run(query, params);
  saveDb();
}

function fetchAll(query, params = []) {
  const stmt = db.prepare(query, params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function fetchOne(query, params = []) {
  const rows = fetchAll(query, params);
  return rows[0] || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error('Request too large'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getAuthToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7);
}

function getCurrentUser(req) {
  const token = getAuthToken(req);
  if (!token) {
    return null;
  }
  const session = sessions.get(token);
  if (!session) {
    return null;
  }
  return fetchOne(
    'SELECT id, username, role, created_at FROM users WHERE id = ?',
    [session.userId]
  );
}

function toPublicUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    role: row.role,
    createdAt: row.created_at,
  };
}

function ensureSeedUsers() {
  const existingAdmin = fetchOne('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!existingAdmin) {
    runQuery(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      ['admin', hashPassword('admin123'), 'admin']
    );
  }

  const existingUser = fetchOne('SELECT id FROM users WHERE username = ?', ['demo']);
  if (!existingUser) {
    runQuery(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      ['demo', hashPassword('demo123'), 'user']
    );
  }
}

function migrateTodos() {
  const columns = fetchAll('PRAGMA table_info(todos)');
  const hasUserId = columns.some(column => column.name === 'user_id');
  if (!hasUserId) {
    runQuery('ALTER TABLE todos ADD COLUMN user_id INTEGER');
  }
  const hasPriority = columns.some(column => column.name === 'priority');
  if (!hasPriority) {
    runQuery("ALTER TABLE todos ADD COLUMN priority TEXT DEFAULT 'medium'");
  }
  const hasCategory = columns.some(column => column.name === 'category');
  if (!hasCategory) {
    runQuery("ALTER TABLE todos ADD COLUMN category TEXT DEFAULT 'General'");
  }
  const hasDueDate = columns.some(column => column.name === 'due_date');
  if (!hasDueDate) {
    runQuery('ALTER TABLE todos ADD COLUMN due_date TEXT');
  }
  const hasNotes = columns.some(column => column.name === 'notes');
  if (!hasNotes) {
    runQuery('ALTER TABLE todos ADD COLUMN notes TEXT');
  }

  const admin = fetchOne('SELECT id FROM users WHERE username = ?', ['admin']);
  if (admin) {
    runQuery('UPDATE todos SET user_id = ? WHERE user_id IS NULL', [admin.id]);
  }
}

async function initDb() {
  const SQL = await initSqlJs();
  fs.mkdirSync(DB_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE) && fs.existsSync(LEGACY_DB_FILE)) {
    fs.copyFileSync(LEGACY_DB_FILE, DB_FILE);
  }
  let data;
  if (fs.existsSync(DB_FILE)) {
    data = fs.readFileSync(DB_FILE);
    db = new SQL.Database(data);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      text TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      priority TEXT DEFAULT 'medium',
      category TEXT DEFAULT 'General',
      due_date TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  saveDb();
  ensureSeedUsers();
  migrateTodos();
  saveDb();
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buffer);
}

function listTodos(user, url) {
  const showAll = user.role === 'admin' && url.searchParams.get('scope') === 'all';
  const filters = [];
  const params = [];

  if (!showAll) {
    filters.push('todos.user_id = ?');
    params.push(user.id);
  }

  const status = url.searchParams.get('status');
  if (status === 'open') {
    filters.push('todos.completed = 0');
  } else if (status === 'done') {
    filters.push('todos.completed = 1');
  }

  const priority = url.searchParams.get('priority');
  if (priority) {
    filters.push('todos.priority = ?');
    params.push(priority);
  }

  const search = url.searchParams.get('search');
  if (search) {
    filters.push('(LOWER(todos.text) LIKE ? OR LOWER(IFNULL(todos.notes, "")) LIKE ?)');
    const pattern = `%${search.toLowerCase()}%`;
    params.push(pattern, pattern);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = fetchAll(
    `
      SELECT todos.*, users.username AS owner_name
      FROM todos
      LEFT JOIN users ON users.id = todos.user_id
      ${where}
      ORDER BY todos.completed ASC, todos.created_at DESC
    `,
    params
  );

  return rows.map(normalizeTodo);
}

function buildDashboard(user) {
  const todoScopeFilter = user.role === 'admin' ? '' : 'WHERE user_id = ?';
  const params = user.role === 'admin' ? [] : [user.id];
  const summary = fetchOne(
    `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END) AS openCount,
        SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS completedCount,
        SUM(CASE WHEN priority = 'high' AND completed = 0 THEN 1 ELSE 0 END) AS highPriority
      FROM todos
      ${todoScopeFilter}
    `,
    params
  ) || {};

  const dashboard = {
    total: Number(summary.total || 0),
    openCount: Number(summary.openCount || 0),
    completedCount: Number(summary.completedCount || 0),
    highPriority: Number(summary.highPriority || 0),
  };

  if (user.role === 'admin') {
    const userSummary = fetchOne(
      `
        SELECT
          COUNT(*) AS totalUsers,
          SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS adminCount,
          SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS memberCount
        FROM users
      `
    ) || {};

    dashboard.totalUsers = Number(userSummary.totalUsers || 0);
    dashboard.adminCount = Number(userSummary.adminCount || 0);
    dashboard.memberCount = Number(userSummary.memberCount || 0);
  }

  return dashboard;
}

function requireAuth(req, res) {
  const user = getCurrentUser(req);
  if (!user) {
    json(res, 401, { error: 'Authentication required' });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) {
    return null;
  }
  if (user.role !== 'admin') {
    json(res, 403, { error: 'Admin access required' });
    return null;
  }
  return user;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health' && req.method === 'GET') {
    json(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    const safeUsername = (username || '').trim().toLowerCase();
    if (safeUsername.length < 3 || (password || '').length < 6) {
      json(res, 400, { error: 'Username must be at least 3 characters and password at least 6 characters' });
      return true;
    }

    const existing = fetchOne('SELECT id FROM users WHERE username = ?', [safeUsername]);
    if (existing) {
      json(res, 409, { error: 'Username already exists' });
      return true;
    }

    runQuery(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      [safeUsername, hashPassword(password), 'user']
    );
    const created = fetchOne('SELECT id, username, role, created_at FROM users WHERE username = ?', [safeUsername]);
    const token = createToken();
    sessions.set(token, { userId: Number(created.id) });
    json(res, 201, { token, user: toPublicUser(created) });
    return true;
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    const safeUsername = (username || '').trim().toLowerCase();
    const user = fetchOne(
      'SELECT id, username, role, created_at, password_hash FROM users WHERE username = ?',
      [safeUsername]
    );
    if (!user || user.password_hash !== hashPassword(password || '')) {
      json(res, 401, { error: 'Invalid username or password' });
      return true;
    }
    const token = createToken();
    sessions.set(token, { userId: Number(user.id) });
    json(res, 200, { token, user: toPublicUser(user) });
    return true;
  }

  if (url.pathname === '/api/auth/session' && req.method === 'GET') {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    json(res, 200, { user: toPublicUser(user) });
    return true;
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = getAuthToken(req);
    if (token) {
      sessions.delete(token);
    }
    json(res, 200, { success: true });
    return true;
  }

  if (url.pathname === '/api/dashboard' && req.method === 'GET') {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    json(res, 200, buildDashboard(user));
    return true;
  }

  if (url.pathname === '/api/users' && req.method === 'GET') {
    const admin = requireAdmin(req, res);
    if (!admin) {
      return true;
    }
    const users = fetchAll(
      `
        SELECT
          users.id,
          users.username,
          users.role,
          users.created_at,
          COUNT(todos.id) AS task_count
        FROM users
        LEFT JOIN todos ON todos.user_id = users.id
        GROUP BY users.id
        ORDER BY users.role DESC, users.username ASC
      `
    ).map(row => ({
      id: Number(row.id),
      username: row.username,
      role: row.role,
      createdAt: row.created_at,
      taskCount: Number(row.task_count || 0),
    }));
    json(res, 200, users);
    return true;
  }

  if (url.pathname.startsWith('/api/users/') && url.pathname.endsWith('/role') && req.method === 'PUT') {
    const admin = requireAdmin(req, res);
    if (!admin) {
      return true;
    }
    const userId = Number(url.pathname.split('/')[3]);
    const { role } = await readBody(req);
    if (!['admin', 'user'].includes(role)) {
      json(res, 400, { error: 'Invalid role' });
      return true;
    }
    if (userId === Number(admin.id) && role !== 'admin') {
      json(res, 400, { error: 'You cannot remove your own admin access' });
      return true;
    }
    runQuery('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
    const updated = fetchOne('SELECT id, username, role, created_at FROM users WHERE id = ?', [userId]);
    json(res, 200, { user: toPublicUser(updated) });
    return true;
  }

  if (url.pathname === '/api/todos' && req.method === 'GET') {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    json(res, 200, listTodos(user, url));
    return true;
  }

  if (url.pathname === '/api/todos' && req.method === 'POST') {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    const body = await readBody(req);
    const text = (body.text || '').trim();
    if (!text) {
      json(res, 400, { error: 'Task title is required' });
      return true;
    }

    let ownerId = Number(user.id);
    if (user.role === 'admin' && body.ownerId) {
      ownerId = Number(body.ownerId);
    }

    runQuery(
      `
        INSERT INTO todos (user_id, text, completed, priority, category, due_date, notes)
        VALUES (?, ?, 0, ?, ?, ?, ?)
      `,
      [
        ownerId,
        text,
        body.priority || 'medium',
        body.category || 'General',
        body.dueDate || '',
        body.notes || '',
      ]
    );
    const lastId = fetchOne('SELECT last_insert_rowid() AS id');
    const created = fetchOne(
      `
        SELECT todos.*, users.username AS owner_name
        FROM todos
        LEFT JOIN users ON users.id = todos.user_id
        WHERE todos.id = ?
      `,
      [lastId.id]
    );
    json(res, 201, normalizeTodo(created));
    return true;
  }

  if (url.pathname.startsWith('/api/todos/') && req.method === 'PUT') {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    const todoId = Number(url.pathname.split('/')[3]);
    const existing = fetchOne('SELECT * FROM todos WHERE id = ?', [todoId]);
    if (!existing) {
      json(res, 404, { error: 'Task not found' });
      return true;
    }
    if (user.role !== 'admin' && Number(existing.user_id) !== Number(user.id)) {
      json(res, 403, { error: 'You cannot edit this task' });
      return true;
    }

    const body = await readBody(req);
    const text = body.text !== undefined ? String(body.text).trim() : existing.text;
    if (!text) {
      json(res, 400, { error: 'Task title is required' });
      return true;
    }

    const ownerId =
      user.role === 'admin' && body.ownerId ? Number(body.ownerId) : Number(existing.user_id);

    runQuery(
      `
        UPDATE todos
        SET text = ?, completed = ?, priority = ?, category = ?, due_date = ?, notes = ?, user_id = ?
        WHERE id = ?
      `,
      [
        text,
        body.completed !== undefined ? (body.completed ? 1 : 0) : existing.completed,
        body.priority || existing.priority || 'medium',
        body.category !== undefined ? body.category : existing.category,
        body.dueDate !== undefined ? body.dueDate : existing.due_date,
        body.notes !== undefined ? body.notes : existing.notes,
        ownerId,
        todoId,
      ]
    );
    const updated = fetchOne(
      `
        SELECT todos.*, users.username AS owner_name
        FROM todos
        LEFT JOIN users ON users.id = todos.user_id
        WHERE todos.id = ?
      `,
      [todoId]
    );
    json(res, 200, normalizeTodo(updated));
    return true;
  }

  if (url.pathname.startsWith('/api/todos/') && req.method === 'DELETE') {
    const user = requireAuth(req, res);
    if (!user) {
      return true;
    }
    const todoId = Number(url.pathname.split('/')[3]);
    const existing = fetchOne('SELECT * FROM todos WHERE id = ?', [todoId]);
    if (!existing) {
      json(res, 404, { error: 'Task not found' });
      return true;
    }
    if (user.role !== 'admin' && Number(existing.user_id) !== Number(user.id)) {
      json(res, 403, { error: 'You cannot delete this task' });
      return true;
    }
    runQuery('DELETE FROM todos WHERE id = ?', [todoId]);
    json(res, 200, { success: true });
    return true;
  }

  return false;
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

  try {
    const handled = await handleApi(req, res, url);
    if (handled) {
      return;
    }
  } catch (error) {
    json(res, 500, { error: error.message || 'Internal server error' });
    return;
  }

  const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, safePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain' });
    res.end(content);
  });
});

initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
