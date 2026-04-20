const http = require('http');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const PORT = 3060;
const DB_FILE = path.join(__dirname, 'todos.db');

let db;

async function initDb() {
  const SQL = await initSqlJs();
  let data;
  if (fs.existsSync(DB_FILE)) {
    data = fs.readFileSync(DB_FILE);
    db = new SQL.Database(data);
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  saveDb();
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buffer);
}

function loadTodos() {
  const stmt = db.prepare('SELECT * FROM todos ORDER BY created_at DESC');
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const server = http.createServer((req, res) => {
  if (req.url === '/api/todos' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadTodos()));
    return;
  }

  if (req.url === '/api/todos' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const { text } = JSON.parse(body);
      db.run('INSERT INTO todos (text, completed) VALUES (?, 0)', [text]);
      const lastId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
      const todo = { id: lastId, text, completed: 0 };
      saveDb();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(todo));
    });
    return;
  }

  if (req.url.startsWith('/api/todos/') && req.method === 'PUT') {
    const id = req.url.split('/')[3];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const { completed } = JSON.parse(body);
      db.run('UPDATE todos SET completed = ? WHERE id = ?', [completed ? 1 : 0, id]);
      saveDb();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  if (req.url.startsWith('/api/todos/') && req.method === 'DELETE') {
    const id = req.url.split('/')[3];
    db.run('DELETE FROM todos WHERE id = ?', [id]);
    saveDb();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;
  const fullPath = path.join(__dirname, 'public', filePath);
  const ext = path.extname(fullPath);
  const contentType = MIME_TYPES[ext] || 'text/plain';

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});