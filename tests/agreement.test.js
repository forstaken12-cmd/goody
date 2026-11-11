'use strict';

// One-time agreement: age + Terms boxes are saved on the user row, returning
// people never tick them again, and a TERMS_VERSION bump asks once more.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { createApp } = require('../server/app');
const { openDb, migrate, schemaSql } = require('../server/db');
const policy = require('../server/lib/policy');

let app, server, base, keys;
const leftover = [];

function readCookie(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const m = String(c).match(/goody_session=([^;]+)/);
    if (m) return m[1];
  }
  return '';
}

function post(p, body, cookie) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = 'goody_session=' + cookie;
  return fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body || {}) });
}

function me(cookie) {
  return fetch(base + '/api/me', { headers: { cookie: 'goody_session=' + cookie } }).then((r) => r.json());
}

// Run a full Google sign-in. `sub` picks which Google person signs in.
async function googleSignIn(sub, query) {
  const start = await fetch(base + '/api/auth/google/start' + (query ? '?' + query : ''), { redirect: 'manual' });
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  const code = sub + ':' + loc.searchParams.get('nonce');
  const cb = await fetch(base + '/api/auth/google/callback?code=' + encodeURIComponent(code) + '&state=' + loc.searchParams.get('state'), { redirect: 'manual' });
  assert.equal(cb.status, 302);
  return { cookie: readCookie(cb), location: new URL(cb.headers.get('location'), base) };
}

before(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = 'agree-test';
  jwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const clientId = 'agree-test.apps.googleusercontent.com';
  async function oauthFetch(_url, init) {
    const raw = new URLSearchParams(init.body).get('code') || '';
    const [sub, nonce] = raw.split(':');
    const id_token = await new SignJWT({ email: sub + '@example.com', email_verified: true, nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'agree-test' })
      .setIssuer('https://accounts.google.com')
      .setAudience(clientId)
      .setSubject('g-' + sub)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keys.privateKey);
    return { ok: true, json: async () => ({ id_token }) };
  }
  app = await createApp({
    memory: true,
    oauthFetch,
    oauthGoogleJwks: jwks,
    config: {
      demoPartner: true,
      publicBaseUrl: 'http://127.0.0.1',
      secureCookies: false,
      googleClientId: clientId,
      googleClientSecret: 'test-only'
    }
  });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = 'http://127.0.0.1:' + server.address().port;
});

after(() => {
  if (server) server.close();
  for (const p of leftover) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
});

test('the age rule and Terms version live in one place and reach the client', async () => {
  assert.equal(policy.MIN_AGE, 18);
  assert.match(policy.TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.minAge, policy.MIN_AGE);
  assert.equal(cfg.termsVersion, policy.TERMS_VERSION);
  assert.equal(policy.agreeMessage(), 'Please confirm you are 18 or older and agree to the Terms and Privacy Policy.');
});

test('email sign-up saves the agreement on the user row', async () => {
  const bad = await post('/api/auth/signup', { email: 'nobox@example.com', password: 'password12' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'NEED_AGREE');

  const res = await post('/api/auth/signup', { email: 'boxes@example.com', password: 'password12', agreeTerms: true, ageConfirm: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.termsOk, true);
  const row = await app.locals.db.get('SELECT * FROM users WHERE email = ?', ['boxes@example.com']);
  assert.ok(row.agreed_terms_at);
  assert.equal(row.terms_version, policy.TERMS_VERSION);
  assert.equal(Number(row.age_confirmed), 1);
  assert.equal(Number(row.age_confirmed_min), policy.MIN_AGE);
  assert.equal((await me(readCookie(res))).termsOk, true);
});

test('Google: a new person must tick the boxes, a returning person never does', async () => {
  // New, no boxes: sent back with the friendly message, no account made.
  const fresh = await googleSignIn('newbie');
  assert.equal(fresh.cookie, '');
  assert.equal(fresh.location.searchParams.get('authError'), policy.agreeMessage());
  assert.equal(await app.locals.db.get('SELECT id FROM users WHERE google_id = ?', ['g-newbie']), undefined);

  // New, with boxes: account made and agreement saved.
  const first = await googleSignIn('newbie', 'agree=1&age=1');
  assert.ok(first.cookie);
  assert.equal((await me(first.cookie)).termsOk, true);

  // Returning, no boxes at all: signs straight in.
  const again = await googleSignIn('newbie');
  assert.ok(again.cookie);
  assert.equal(again.location.searchParams.get('authError'), null);
  const m = await me(again.cookie);
  assert.equal(m.email, 'newbie@example.com');
  assert.equal(m.termsOk, true);
});

test('a TERMS_VERSION bump asks once more, then never again', async () => {
  const { cookie } = await googleSignIn('oldie', 'agree=1&age=1');
  // Pretend this person agreed to an older version.
  await app.locals.db.run('UPDATE users SET terms_version = ? WHERE google_id = ?', ['2000-01-01', 'g-oldie']);
  assert.equal((await me(cookie)).termsOk, false);

  // Returning sign-in still works without boxes; the app then shows them once.
  const back = await googleSignIn('oldie');
  assert.ok(back.cookie);
  assert.equal((await me(back.cookie)).termsOk, false);

  // Earning and cash-out wait for the new agreement.
  const blocked = await post('/api/offers/dragon/start', {}, back.cookie);
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, 'NEED_AGREE');
  const cash = await post('/api/cashout', { method: 'paypal', destination: 'a@example.com' }, back.cookie);
  assert.equal(cash.status, 403);

  // Ticking only one box is not enough.
  const half = await post('/api/auth/agree', { agree: true }, back.cookie);
  assert.equal(half.status, 400);

  const ok = await post('/api/auth/agree', { agree: true, age: true }, back.cookie);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).user.termsOk, true);
  assert.equal((await me(back.cookie)).termsOk, true);
  const row = await app.locals.db.get('SELECT terms_version FROM users WHERE google_id = ?', ['g-oldie']);
  assert.equal(row.terms_version, policy.TERMS_VERSION);

  const allowed = await post('/api/offers/dragon/start', {}, back.cookie);
  assert.notEqual(allowed.status, 403);
});

test('ticking the boxes on a returning Google sign-in saves the new version', async () => {
  await googleSignIn('ticker', 'agree=1&age=1');
  await app.locals.db.run('UPDATE users SET terms_version = NULL WHERE google_id = ?', ['g-ticker']);
  const back = await googleSignIn('ticker', 'agree=1&age=1');
  assert.equal((await me(back.cookie)).termsOk, true);
});

test('/api/auth/agree needs a session', async () => {
  const res = await post('/api/auth/agree', { agree: true, age: true });
  assert.equal(res.status, 401);
});

test('sql.js migration adds terms_version and age_confirmed_min to an old users table', async () => {
  const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.js')), f) });
  const old = new SQL.Database();
  old.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, public_id TEXT UNIQUE NOT NULL, email TEXT UNIQUE,
    password_hash TEXT, email_verified_at TEXT, agreed_terms_at TEXT, age_confirmed INTEGER NOT NULL DEFAULT 0,
    device_fingerprint TEXT, device_note TEXT, device_id TEXT, google_id TEXT UNIQUE, apple_id TEXT UNIQUE,
    created_at TEXT NOT NULL, first_cashout_at TEXT, last_seen_at TEXT)`);
  old.run("INSERT INTO users (public_id, email, agreed_terms_at, age_confirmed, created_at) VALUES ('u_old', 'old@example.com', '2026-01-01', 1, '2026-01-01')");
  const file = path.join(os.tmpdir(), 'goody-agree-' + process.pid + '.sqlite');
  leftover.push(file);
  fs.writeFileSync(file, Buffer.from(old.export()));
  const db = await openDb({ forceSqlite: true, path: file });
  const cols = (await db.all('PRAGMA table_info(users)')).map((c) => c.name);
  assert.ok(cols.includes('terms_version'));
  assert.ok(cols.includes('age_confirmed_min'));
  const row = await db.get('SELECT * FROM users WHERE public_id = ?', ['u_old']);
  assert.equal(row.terms_version, null);
  assert.equal(policy.termsCurrent(row), false);
});

test('Postgres migration adds the same two columns', async () => {
  const pgSchema = schemaSql('pg');
  assert.match(pgSchema, /terms_version TEXT/);
  assert.match(pgSchema, /age_confirmed_min INTEGER/);
  // A pg-shaped db whose users table is from before this change.
  const existing = ['id', 'public_id', 'email', 'password_hash', 'email_verified_at', 'agreed_terms_at',
    'age_confirmed', 'device_fingerprint', 'device_note', 'google_id', 'apple_id',
    'payout_provider', 'payout_mode', 'payout_ref', 'payout_error'];
  const ran = [];
  const fake = {
    dialect: 'pg',
    async exec(sql) { ran.push(String(sql)); },
    async all() { return existing.map((name) => ({ name, is_nullable: 'YES' })); },
    async get() { return undefined; },
    async run() { return { changes: 0 }; }
  };
  await migrate(fake);
  assert.ok(ran.includes('ALTER TABLE users ADD COLUMN terms_version TEXT'));
  assert.ok(ran.includes('ALTER TABLE users ADD COLUMN age_confirmed_min INTEGER'));
});

test('Terms and Privacy show the age from the one constant, COPPA, and the PayPal note', async () => {
  for (const p of ['/terms', '/privacy']) {
    const html = await (await fetch(base + p)).text();
    assert.doesNotMatch(html, /\{\{MIN_AGE\}\}/);
    assert.match(html, new RegExp(policy.MIN_AGE + ' or older'));
    assert.match(html, /under 13/);
    assert.match(html, /COPPA/);
    assert.match(html, /PayPal/);
  }
});
