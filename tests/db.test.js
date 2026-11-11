'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { openDb, isPostgresUrl, convertPlaceholders } = require('../server/db');

const leftover = [];
after(() => {
  for (const p of leftover) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
});

test('isPostgresUrl accepts only postgres schemes', () => {
  assert.equal(isPostgresUrl('postgres://user:pass@host/db'), true);
  assert.equal(isPostgresUrl('postgresql://user:pass@host/db'), true);
  assert.equal(isPostgresUrl('  PostgreSQL://host/db  '), true);
  assert.equal(isPostgresUrl(''), false);
  assert.equal(isPostgresUrl(null), false);
  assert.equal(isPostgresUrl('placeholder'), false);
  assert.equal(isPostgresUrl('mysql://host/db'), false);
  assert.equal(isPostgresUrl('http://example.com'), false);
});

test('convertPlaceholders turns ? into $1 $2 for Postgres', () => {
  assert.equal(
    convertPlaceholders('SELECT * FROM users WHERE email = ? AND id = ?'),
    'SELECT * FROM users WHERE email = $1 AND id = $2'
  );
  assert.equal(convertPlaceholders('SELECT 1'), 'SELECT 1');
});

test('sql.js memory database: tables, insert, get, unique email, lastInsertRowid', async () => {
  const db = await openDb({ memory: true });
  assert.equal(db.dialect, 'sqlite');
  const now = new Date().toISOString();
  const r = await db.run(
    'INSERT INTO users (public_id, email, password_hash, age_confirmed, created_at, last_seen_at) VALUES (?, ?, ?, 1, ?, ?)',
    ['u_dbtest', 'dbtest@example.com', 'hash', now, now]
  );
  assert.ok(r.lastInsertRowid);
  const row = await db.get('SELECT * FROM users WHERE id = ?', [r.lastInsertRowid]);
  assert.equal(row.email, 'dbtest@example.com');
  assert.equal(row.public_id, 'u_dbtest');

  await assert.rejects(
    () => db.run(
      'INSERT INTO users (public_id, email, password_hash, age_confirmed, created_at, last_seen_at) VALUES (?, ?, ?, 1, ?, ?)',
      ['u_dbtest2', 'dbtest@example.com', 'hash', now, now]
    )
  );

  const users = await db.all('SELECT * FROM users WHERE email = ?', ['dbtest@example.com']);
  assert.equal(users.length, 1);
  await db.close();
});

test('a DATABASE_URL that is not a postgres URL falls back to sql.js', async () => {
  const path = '/tmp/goody-fallback-noturl.sqlite';
  leftover.push(path);
  try { fs.unlinkSync(path); } catch { /* ignore */ }
  const db = await openDb({ databaseUrl: 'placeholder-not-a-real-url', path });
  assert.equal(db.dialect, 'sqlite');
  const row = await db.get('SELECT COUNT(*) AS n FROM users');
  assert.equal(Number(row.n) >= 0, true);
  await db.close();
});

test('a postgres URL that cannot connect falls back to sql.js', async () => {
  const path = '/tmp/goody-fallback-badpg.sqlite';
  leftover.push(path);
  try { fs.unlinkSync(path); } catch { /* ignore */ }
  const db = await openDb({
    databaseUrl: 'postgres://invalid:invalid@127.0.0.1:1/nope',
    path
  });
  assert.equal(db.dialect, 'sqlite');
  await db.close();
});

test('memory: true ignores DATABASE_URL', async () => {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://should-not-be-used@127.0.0.1:1/x';
  try {
    const db = await openDb({ memory: true });
    assert.equal(db.dialect, 'sqlite');
    await db.close();
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  }
});
