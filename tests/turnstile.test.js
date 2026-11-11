'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const turnstile = require('../server/lib/turnstile');

// Cloudflare's official Turnstile test keys
const PASS_SITE = '1x00000000000000000000AA';
const PASS_SECRET = '1x0000000000000000000000000000000AA';
const FAIL_SITE = '2x00000000000000000000AB';
const FAIL_SECRET = '2x0000000000000000000000000000000AA';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const servers = [];
after(() => { for (const s of servers) s.close(); });

// Mock of POST /turnstile/v0/siteverify that behaves like the test secrets.
function mockSiteverify(calls) {
  return async (url, init) => {
    const body = new URLSearchParams(init.body);
    calls.push({ url, secret: body.get('secret'), response: body.get('response'), signal: init.signal });
    const ok = body.get('secret') === PASS_SECRET && body.get('response') === DUMMY_TOKEN;
    return {
      status: 200,
      json: async () => ok
        ? { success: true, 'error-codes': [], hostname: 'example.com' }
        : { success: false, 'error-codes': ['invalid-input-response'] }
    };
  };
}

async function start(cfgExtra, calls) {
  const app = await createApp({
    memory: true,
    turnstileFetch: mockSiteverify(calls || []),
    config: Object.assign({
      demoPartner: true,
      publicBaseUrl: 'http://127.0.0.1',
      secureCookies: false,
      googleClientId: 'gid.apps.googleusercontent.com',
      googleClientSecret: 'gsecret'
    }, cfgExtra || {})
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  return 'http://127.0.0.1:' + server.address().port;
}

function post(base, path, body) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const signupBody = (email, extra) => Object.assign({
  email, password: 'password12', agreeTerms: true, ageConfirm: true
}, extra || {});

test('captcha is off when either key is missing; health and config say so', async () => {
  assert.equal(turnstile.turnstileEnabled({}), false);
  assert.equal(turnstile.turnstileEnabled({ turnstileSiteKey: PASS_SITE }), false);
  assert.equal(turnstile.turnstileEnabled({ turnstileSecretKey: PASS_SECRET }), false);
  const calls = [];
  const base = await start({ turnstileSiteKey: PASS_SITE, turnstileSecretKey: '' }, calls);
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.turnstile, false);
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.turnstileSiteKey, null);
  const r = await post(base, '/api/auth/signup', signupBody('off@example.com'));
  assert.equal(r.status, 200);
  assert.equal(calls.length, 0, 'siteverify must not be called when captcha is off');
});

test('always-pass keys: signup, login, and forgot work with the dummy token', async () => {
  const calls = [];
  const base = await start({ turnstileSiteKey: PASS_SITE, turnstileSecretKey: PASS_SECRET }, calls);
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.turnstile, true);
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.turnstileSiteKey, PASS_SITE);
  assert.ok(!JSON.stringify(cfg).includes(PASS_SECRET), 'secret must never reach the client');

  const su = await post(base, '/api/auth/signup', signupBody('pass@example.com', { turnstileToken: DUMMY_TOKEN }));
  assert.equal(su.status, 200);
  const li = await post(base, '/api/auth/login', { email: 'pass@example.com', password: 'password12', turnstileToken: DUMMY_TOKEN });
  assert.equal(li.status, 200);
  const fo = await post(base, '/api/auth/forgot', { email: 'pass@example.com', turnstileToken: DUMMY_TOKEN });
  assert.equal(fo.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, turnstile.SITEVERIFY_URL);
  assert.ok(calls[0].signal, 'siteverify uses a timeout signal');
});

test('missing token gets the kid-simple message without calling Cloudflare', async () => {
  const calls = [];
  const base = await start({ turnstileSiteKey: PASS_SITE, turnstileSecretKey: PASS_SECRET }, calls);
  for (const [path, body] of [
    ['/api/auth/signup', signupBody('none@example.com')],
    ['/api/auth/login', { email: 'none@example.com', password: 'password12' }],
    ['/api/auth/forgot', { email: 'none@example.com' }]
  ]) {
    const r = await post(base, path, body);
    assert.equal(r.status, 400, path);
    assert.equal((await r.json()).error, 'Please finish the quick check.');
  }
  assert.equal(calls.length, 0);
});

test('always-fail keys reject signup, login, and forgot', async () => {
  const calls = [];
  const base = await start({ turnstileSiteKey: FAIL_SITE, turnstileSecretKey: FAIL_SECRET }, calls);
  const su = await post(base, '/api/auth/signup', signupBody('fail@example.com', { turnstileToken: DUMMY_TOKEN }));
  assert.equal(su.status, 400);
  assert.equal((await su.json()).error, 'Please finish the quick check.');
  const li = await post(base, '/api/auth/login', { email: 'fail@example.com', password: 'password12', turnstileToken: DUMMY_TOKEN });
  assert.equal(li.status, 400);
  const fo = await post(base, '/api/auth/forgot', { email: 'fail@example.com', turnstileToken: DUMMY_TOKEN });
  assert.equal(fo.status, 400);
  assert.equal(calls.length, 3);
});

test('Google start skips the quick check; Apple start keeps it', async () => {
  const calls = [];
  // Start only checks that Apple is set up; nothing is signed here.
  const appleKey = 'not-a-real-key';
  const base = await start({
    turnstileSiteKey: PASS_SITE, turnstileSecretKey: PASS_SECRET,
    appleClientId: 'com.goody.test.web', appleTeamId: 'TEAM12TEST', appleKeyId: 'KEY12TEST', applePrivateKey: appleKey
  }, calls);

  // Google: no token needed, and siteverify is never called.
  const g = await fetch(base + '/api/auth/google/start?agree=1&age=1', { redirect: 'manual' });
  assert.equal(g.status, 302);
  assert.match(g.headers.get('location'), /^https:\/\/accounts\.google\.com\//);
  assert.equal(calls.length, 0);

  // Apple: still needs the quick check.
  const noTok = await fetch(base + '/api/auth/apple/start?agree=1&age=1', { redirect: 'manual' });
  assert.equal(noTok.status, 302);
  const back = new URL(noTok.headers.get('location'), base);
  assert.equal(back.pathname, '/');
  assert.equal(back.searchParams.get('authError'), 'Please finish the quick check.');

  const ok = await fetch(base + '/api/auth/apple/start?agree=1&age=1&turnstileToken=' + encodeURIComponent(DUMMY_TOKEN), { redirect: 'manual' });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get('location'), /^https:\/\/appleid\.apple\.com\//);

  const failCalls = [];
  const failBase = await start({
    turnstileSiteKey: FAIL_SITE, turnstileSecretKey: FAIL_SECRET,
    appleClientId: 'com.goody.test.web', appleTeamId: 'TEAM12TEST', appleKeyId: 'KEY12TEST', applePrivateKey: appleKey
  }, failCalls);
  const bad = await fetch(failBase + '/api/auth/apple/start?agree=1&age=1&turnstileToken=' + encodeURIComponent(DUMMY_TOKEN), { redirect: 'manual' });
  assert.equal(new URL(bad.headers.get('location'), failBase).searchParams.get('authError'), 'Please finish the quick check.');
});

test('a hanging siteverify times out quickly and fails closed', async () => {
  const cfg = { turnstileSiteKey: PASS_SITE, turnstileSecretKey: PASS_SECRET };
  const t0 = Date.now();
  const r = await turnstile.verifyTurnstile(cfg, DUMMY_TOKEN, {
    timeoutMs: 50,
    fetchFn: (_u, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'TimeoutError'; rej(e);
      });
    })
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.codes, ['siteverify-timeout']);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(turnstile.TURNSTILE_TIMEOUT_MS, 8000);
});
