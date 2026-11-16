'use strict';

// Demo partner is opt-in (DEMO_PARTNER=1). Off by default: no fake catalog, start/play 403.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const config = require('../server/config');

const servers = [];

function listen(a) {
  return new Promise((resolve) => {
    const s = a.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function start(opts) {
  const app = await createApp(Object.assign({ memory: true }, opts || {}));
  const server = await listen(app);
  servers.push(server);
  return { app, base: 'http://127.0.0.1:' + server.address().port };
}

function readCookie(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw || []) {
    const m = String(c).match(/goody_session=([^;]+)/);
    if (m) return m[1];
  }
  return '';
}

async function json(base, method, url, body, cookie) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = 'goody_session=' + cookie;
  const res = await fetch(base + url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, cookie: readCookie(res) };
}

async function signup(base, email) {
  const ses = await json(base, 'POST', '/api/auth/signup', {
    email, password: 'password12', agreeTerms: true, ageConfirm: true
  });
  assert.equal(ses.status, 200, ses.data);
  return ses.cookie;
}

after(() => {
  for (const s of servers) s.close();
});

test('demo partner default is off unless DEMO_PARTNER is exactly 1', () => {
  // The loaded config follows the process env; with no DEMO_PARTNER=1 it must be off.
  if (process.env.DEMO_PARTNER === '1') {
    assert.equal(config.demoPartner, true);
  } else {
    assert.equal(config.demoPartner, false);
  }
});

test('createApp without a demo override hides the catalog and rejects start/play', async () => {
  const { base } = await start();
  const cfg = await json(base, 'GET', '/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.data.demo, false);

  const cookie = await signup(base, 'nodemo@example.com');
  const list = await json(base, 'GET', '/api/offers', null, cookie);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.offers, []);

  const one = await json(base, 'GET', '/api/offers/dragon', null, cookie);
  assert.equal(one.status, 404);

  const startOff = await json(base, 'POST', '/api/offers/dragon/start', {}, cookie);
  assert.equal(startOff.status, 403);
  assert.match(String(startOff.data.error || ''), /demo partner is off/i);

  const playOff = await json(base, 'POST', '/api/offers/dragon/play', { minutes: 5 }, cookie);
  assert.equal(playOff.status, 403);
});

test('DEMO_PARTNER can be turned on through opts.config', async () => {
  const { base } = await start({ config: { demoPartner: true } });
  const cfg = await json(base, 'GET', '/api/config');
  assert.equal(cfg.data.demo, true);

  const cookie = await signup(base, 'yesdemo@example.com');
  const list = await json(base, 'GET', '/api/offers', null, cookie);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data.offers));
  assert.ok(list.data.offers.length > 0);

  const one = await json(base, 'GET', '/api/offers/' + list.data.offers[0].id, null, cookie);
  assert.equal(one.status, 200);
  assert.equal(one.data.offer.id, list.data.offers[0].id);
});
