'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { createApp } = require('../server/app');
const { openDb, wrapPostgres, convertPlaceholders } = require('../server/db');

let googleKeys;
let app, server, base, db;

function listen(a) {
  return new Promise((resolve) => {
    const s = a.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function readCookie(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const c of raw || []) {
    const m = String(c).match(/goody_session=([^;]+)/);
    if (m) return m[1];
  }
  return '';
}

/**
 * A node-pg-shaped pool that executes wrapPostgres's $1 SQL against sql.js.
 * This exercises placeholder conversion and INSERT ... RETURNING id.
 */
function sqliteAsPgPool(sqlite) {
  return {
    async query(text, params) {
      const src = String(text);
      const values = [];
      const sql = src.replace(/\$(\d+)/g, (_, n) => {
        values.push((params || [])[Number(n) - 1]);
        return '?';
      });
      const returning = /\breturning\s+id\s*$/i.test(src);
      const base = returning ? sql.replace(/\s+RETURNING\s+id\s*$/i, '') : sql;
      if (/^\s*select\b/i.test(base) && !returning) {
        const rows = await sqlite.all(base, values);
        return { rows: rows || [], rowCount: (rows || []).length };
      }
      if (returning) {
        const r = await sqlite.run(base, values);
        return { rows: [{ id: r.lastInsertRowid }], rowCount: r.changes };
      }
      if (/^\s*(insert|update|delete)\b/i.test(base)) {
        const r = await sqlite.run(base, values);
        return { rows: [], rowCount: r.changes };
      }
      await sqlite.exec(src);
      return { rows: [], rowCount: 0 };
    },
    async end() {}
  };
}

async function mintIdToken(privateKey, { alg, kid, iss, aud, sub, email, emailVerified, nonce }) {
  const payload = { email, email_verified: emailVerified, nonce };
  return new SignJWT(payload)
    .setProtectedHeader({ alg, kid, typ: 'JWT' })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

before(async () => {
  googleKeys = await generateKeyPair('RS256', { extractable: true });
  const gJwk = await exportJWK(googleKeys.publicKey);
  gJwk.kid = 'test-google-pg';
  gJwk.alg = 'RS256';
  gJwk.use = 'sig';
  googleKeys.jwks = createLocalJWKSet({ keys: [gJwk] });
  googleKeys.kid = 'test-google-pg';

  const sqlite = await openDb({ memory: true });
  db = wrapPostgres(sqliteAsPgPool(sqlite));
  assert.equal(db.dialect, 'pg');

  const oauthCfg = {
    demoPartner: true,
    publicBaseUrl: 'http://127.0.0.1',
    secureCookies: false,
    googleClientId: 'google-client-pg.apps.googleusercontent.com',
    googleClientSecret: 'google-secret-pg'
  };

  async function oauthFetch(url, init) {
    const u = String(url);
    const body = new URLSearchParams((init && init.body) || '');
    const rawCode = body.get('code') || '';
    const splitAt = rawCode.indexOf(':');
    const nonce = splitAt === -1 ? '' : rawCode.slice(splitAt + 1);
    if (!u.includes('oauth2.googleapis.com/token')) {
      return { ok: false, json: async () => ({ error: 'unexpected fetch' }) };
    }
    const id_token = await mintIdToken(googleKeys.privateKey, {
      alg: 'RS256',
      kid: googleKeys.kid,
      iss: 'https://accounts.google.com',
      aud: oauthCfg.googleClientId,
      sub: 'google-sub-pg',
      email: 'pg-user@example.com',
      emailVerified: true,
      nonce
    });
    return { ok: true, json: async () => ({ id_token, access_token: 'g-access', token_type: 'Bearer' }) };
  }

  app = await createApp({
    db,
    config: oauthCfg,
    oauthFetch,
    oauthGoogleJwks: googleKeys.jwks
  });
  server = await listen(app);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

test('loginWithOauth insert uses the same number of ? placeholders as values (pg conversion safe)', () => {
  const sql = `INSERT INTO users (public_id, email, password_hash, email_verified_at, agreed_terms_at, age_confirmed, device_fingerprint, device_note, google_id, apple_id, created_at, last_seen_at)
       VALUES (?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?, ?)`;
  const converted = convertPlaceholders(sql);
  const count = (sql.match(/\?/g) || []).length;
  assert.equal(count, 10);
  assert.equal((converted.match(/\$\d+/g) || []).length, 10);
  assert.match(converted, /\$10/);
  assert.doesNotMatch(converted, /\?/);
  // wrapPostgres appends RETURNING id for the users table
  assert.match(sql, /INSERT\s+INTO\s+users/i);
});

test('full Google callback against the Postgres wrapper creates a session', async () => {
  const start = await fetch(base + '/api/auth/google/start?agree=1&age=1', { redirect: 'manual' });
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  const state = loc.searchParams.get('state');
  const nonce = loc.searchParams.get('nonce');
  assert.ok(state);
  assert.ok(nonce);

  // State must be readable through wrapPostgres.get (rows[0])
  const row = await db.get('SELECT * FROM oauth_states WHERE id = ?', [state]);
  assert.ok(row);
  assert.equal(row.provider, 'google');
  assert.equal(row.nonce, nonce);

  const cb = await fetch(
    base + '/api/auth/google/callback?code=' + encodeURIComponent('code-pg:' + nonce) + '&state=' + state,
    { redirect: 'manual' }
  );
  assert.equal(cb.status, 302);
  const dest = new URL(cb.headers.get('location'), base);
  assert.equal(dest.pathname, '/');
  assert.equal(dest.searchParams.get('authError'), null);
  const cookie = readCookie(cb);
  assert.ok(cookie, 'session cookie must be set on the callback 302');

  const status = await fetch(base + '/api/auth/status', { headers: { cookie: 'goody_session=' + cookie } });
  assert.equal(status.status, 200);
  const st = await status.json();
  assert.equal(st.signedIn, true);
  assert.equal(st.user.email, 'pg-user@example.com');
  assert.equal(st.user.emailVerified, true);
  assert.equal(st.user.googleLinked, true);

  const me = await fetch(base + '/api/me', { headers: { cookie: 'goody_session=' + cookie } });
  assert.equal(me.status, 200);
  const user = await me.json();
  assert.equal(user.email, 'pg-user@example.com');
  assert.equal(user.googleLinked, true);
  assert.ok(user.publicId);

  const gone = await db.get('SELECT * FROM oauth_states WHERE id = ?', [state]);
  assert.equal(gone, undefined);
});
