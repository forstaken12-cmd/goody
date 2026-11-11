'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createApp } = require('../server/app');
const { createMailer } = require('../server/lib/mail');
const payouts = require('../server/lib/payouts');

let app, server, base;
const mailer = createMailer({}); // log provider

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

async function json(method, url, body, headers) {
  const res = await fetch(base + url, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body != null ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, cookie: readCookie(res), headers: res.headers };
}

function auth(cookie) {
  return { cookie: 'goody_session=' + cookie };
}

function tokenFromLink(link) {
  if (!link) return '';
  try {
    const u = new URL(link);
    return u.searchParams.get('token') || '';
  } catch {
    const i = String(link).indexOf('token=');
    return i >= 0 ? decodeURIComponent(String(link).slice(i + 6).split('&')[0]) : '';
  }
}

before(async () => {
  app = await createApp({
    memory: true,
    mailer,
    config: {
      demoPartner: true,
      demoPendingMs: 0,
      demoPaidMs: 0,
      demoRejectRate: 0,
      sharePct: 0.7,
      pointUsd: 0.001,
      firstCashoutUsd: 0.5,
      publicBaseUrl: 'http://127.0.0.1',
      adminPassword: 'test-admin',
      secureCookies: false,
      partners: {
        demo: { name: 'Demo', secret: 'auth-demo-secret', style: 'generic', enabled: true }
      }
    }
  });
  server = await listen(app);
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  app.locals.config.publicBaseUrl = base;
});

after(async () => {
  if (app && app.close) await app.close();
  if (server) await new Promise((r) => server.close(r));
});

test('signup needs agreement, age, and a long enough password', async () => {
  const noAgree = await json('POST', '/api/auth/signup', {
    email: 'a@example.com', password: 'password12', agreeTerms: false, ageConfirm: true
  });
  assert.equal(noAgree.status, 400);
  const noAge = await json('POST', '/api/auth/signup', {
    email: 'a@example.com', password: 'password12', agreeTerms: true, ageConfirm: false
  });
  assert.equal(noAge.status, 400);
  const short = await json('POST', '/api/auth/signup', {
    email: 'a@example.com', password: 'short', agreeTerms: true, ageConfirm: true
  });
  assert.equal(short.status, 400);
});

test('signup creates a hashed password, a session cookie, and one account per email', async () => {
  const r = await json('POST', '/api/auth/signup', {
    email: 'Maya@Example.COM',
    password: 'password12',
    agreeTerms: true,
    ageConfirm: true,
    fingerprint: 'fp-one'
  });
  assert.equal(r.status, 200, r.data);
  assert.equal(r.data.user.email, 'maya@example.com');
  assert.equal(r.data.user.emailVerified, false);
  assert.ok(r.cookie);
  const set = r.headers.get('set-cookie') || '';
  assert.match(set, /HttpOnly/i);
  assert.match(set, /goody_session=/);

  const row = await app.locals.db.get('SELECT * FROM users WHERE email = ?', ['maya@example.com']);
  assert.ok(row.password_hash);
  assert.equal(row.password_hash.includes('password12'), false);
  assert.equal(await bcrypt.compare('password12', row.password_hash), true);

  const dup = await json('POST', '/api/auth/signup', {
    email: 'maya@example.com', password: 'password12', agreeTerms: true, ageConfirm: true
  });
  assert.equal(dup.status, 409);
});

test('login works with the right password and fails with the wrong one', async () => {
  const bad = await json('POST', '/api/auth/login', { email: 'maya@example.com', password: 'nope-nope' });
  assert.equal(bad.status, 401);
  const ok = await json('POST', '/api/auth/login', { email: 'maya@example.com', password: 'password12' });
  assert.equal(ok.status, 200, ok.data);
  assert.ok(ok.cookie);
  const me = await json('GET', '/api/me', null, auth(ok.cookie));
  assert.equal(me.status, 200);
  assert.equal(me.data.email, 'maya@example.com');
});

test('logout clears the session', async () => {
  const ok = await json('POST', '/api/auth/login', { email: 'maya@example.com', password: 'password12' });
  const out = await json('POST', '/api/auth/logout', {}, auth(ok.cookie));
  assert.equal(out.status, 200);
  const me = await json('GET', '/api/me', null, auth(ok.cookie));
  assert.equal(me.status, 401);
});

test('email verification uses a logged link when no mail provider is set', async () => {
  assert.equal(mailer.enabled, false);
  assert.ok(mailer.last.link);
  const token = tokenFromLink(mailer.last.link);
  assert.ok(token);
  const v = await json('POST', '/api/auth/verify', { token });
  assert.equal(v.status, 200, v.data);
  assert.equal(v.data.user.emailVerified, true);
  const again = await json('POST', '/api/auth/verify', { token });
  assert.equal(again.status, 400);
});

test('password reset issues a new password and signs old sessions out', async () => {
  const ses = await json('POST', '/api/auth/login', { email: 'maya@example.com', password: 'password12' });
  const forgot = await json('POST', '/api/auth/forgot', { email: 'maya@example.com' });
  assert.equal(forgot.status, 200);
  const token = tokenFromLink(mailer.last.link);
  assert.ok(token);
  const reset = await json('POST', '/api/auth/reset', { token, password: 'newpassword99' });
  assert.equal(reset.status, 200, reset.data);
  const old = await json('GET', '/api/me', null, auth(ses.cookie));
  assert.equal(old.status, 401);
  const next = await json('POST', '/api/auth/login', { email: 'maya@example.com', password: 'newpassword99' });
  assert.equal(next.status, 200, next.data);
});

test('cash out is blocked until the email is confirmed', async () => {
  const r = await json('POST', '/api/auth/signup', {
    email: 'unverified@example.com',
    password: 'password12',
    agreeTerms: true,
    ageConfirm: true
  });
  assert.equal(r.status, 200, r.data);
  const co = await json('POST', '/api/cashout', { method: 'paypal', destination: 'unverified@example.com' }, auth(r.cookie));
  assert.equal(co.status, 403);
  assert.match(String(co.data.error), /confirm your email/i);
});

test('admin approve without payout keys marks the request approved, send manually', async () => {
  const login = await json('POST', '/api/auth/login', { email: 'maya@example.com', password: 'newpassword99' });
  const cookie = login.cookie;
  const user = await app.locals.db.get('SELECT * FROM users WHERE email = ?', ['maya@example.com']);
  await app.locals.ledger.applyPostback(app.locals.db, {
    userId: user.id, partner: 'demo', txId: 'auth-pay-1', offerId: 'dragon',
    source: 'offer', partnerUsd: 2, status: 'paid', sharePct: 0.7, pointUsd: 0.001
  });
  const co = await json('POST', '/api/cashout', {
    method: 'paypal', destination: 'maya@example.com', points: 500
  }, auth(cookie));
  assert.equal(co.status, 200, co.data);
  const admin = await json('POST', '/admin/login', { password: 'test-admin' });
  assert.equal(admin.status, 200, admin.data);
  const ap = await json('POST', '/admin/api/cashouts/' + co.data.cashout.id + '/approve', {}, {
    'x-admin-token': admin.data.token
  });
  assert.equal(ap.status, 200, ap.data);
  assert.equal(ap.data.cashout.status, 'approved');
  assert.equal(ap.data.cashout.payout_mode, 'manual');
  assert.match(String(ap.data.cashout.admin_note), /send manually/i);
  assert.equal(ap.data.payout.sent, false);
});

test('payout status helper reports missing keys as disconnected', () => {
  const s = payouts.statusFromEnv({
    paypalClientId: '',
    paypalClientSecret: '',
    tremendousApiKey: '',
    zbdApiKey: ''
  });
  assert.equal(s.paypal, false);
  assert.equal(s.tremendous, false);
  assert.equal(s.zebedee, false);
});
