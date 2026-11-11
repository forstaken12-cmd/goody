'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,
  device_id TEXT UNIQUE NOT NULL,
  token TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  first_cashout_at TEXT,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  entry_type TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  partner TEXT,
  offer_id TEXT,
  tx_id TEXT,
  partner_usd REAL NOT NULL DEFAULT 0,
  user_usd REAL NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(partner, tx_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, status, entry_type);
CREATE INDEX IF NOT EXISTS idx_ledger_tx ON ledger(partner, tx_id);

CREATE TABLE IF NOT EXISTS cashouts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  destination TEXT NOT NULL,
  points INTEGER NOT NULL,
  usd REAL NOT NULL,
  is_first INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  ledger_id INTEGER,
  admin_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cashouts_user ON cashouts(user_id);

CREATE TABLE IF NOT EXISTS streaks (
  user_id INTEGER PRIMARY KEY,
  current INTEGER NOT NULL DEFAULT 0,
  best INTEGER NOT NULL DEFAULT 0,
  last_date TEXT
);

CREATE TABLE IF NOT EXISTS daily_goals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  goal_key TEXT NOT NULL,
  target INTEGER NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  bonus_tx TEXT,
  UNIQUE(user_id, date, goal_key)
);

CREATE TABLE IF NOT EXISTS offer_progress (
  user_id INTEGER NOT NULL,
  offer_id TEXT NOT NULL,
  started_at TEXT,
  minutes_played INTEGER DEFAULT 0,
  steps_done INTEGER DEFAULT 0,
  status TEXT,
  PRIMARY KEY(user_id, offer_id)
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`;

function wrap(db, persistPath) {
  let saveTimer = null;
  let dirty = false;

  function saveNow() {
    if (!persistPath) return;
    const data = db.export();
    fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    fs.writeFileSync(persistPath, Buffer.from(data));
    dirty = false;
  }

  function saveSoon() {
    if (!persistPath) return;
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) saveNow();
    }, 40);
  }

  function bindParams(stmt, params) {
    if (params == null) return;
    if (Array.isArray(params)) stmt.bind(params);
    else stmt.bind(params);
  }

  function run(sql, params) {
    const stmt = db.prepare(sql);
    try {
      bindParams(stmt, params);
      stmt.step();
    } finally {
      stmt.free();
    }
    saveSoon();
    const rid = db.exec('SELECT last_insert_rowid() AS id');
    const changes = db.getRowsModified();
    const lastId = rid && rid[0] && rid[0].values[0] ? rid[0].values[0][0] : 0;
    return { lastInsertRowid: lastId, changes };
  }

  function get(sql, params) {
    const stmt = db.prepare(sql);
    try {
      bindParams(stmt, params);
      if (!stmt.step()) return undefined;
      return stmt.getAsObject();
    } finally {
      stmt.free();
    }
  }

  function all(sql, params) {
    const stmt = db.prepare(sql);
    const rows = [];
    try {
      bindParams(stmt, params);
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function exec(sql) {
    db.exec(sql);
    saveSoon();
  }

  return {
    run, get, all, exec, saveNow, saveSoon,
    raw: db,
    persistPath
  };
}

async function openDb(opts) {
  opts = opts || {};
  const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
  const SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) });
  const persistPath = opts.memory ? null : opts.path;
  let db;
  if (persistPath && fs.existsSync(persistPath)) {
    db = new SQL.Database(fs.readFileSync(persistPath));
  } else {
    db = new SQL.Database();
  }
  const wrapped = wrap(db, persistPath);
  wrapped.exec(SCHEMA);
  wrapped.saveNow();
  return wrapped;
}

module.exports = { openDb, SCHEMA };
