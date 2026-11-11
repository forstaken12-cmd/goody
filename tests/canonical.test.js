'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server/app');
const { canonicalTarget } = require('../server/lib/canonicalHost');

const servers = [];
after(() => { for (const s of servers) s.close(); });

async function start(config) {
  const app = await createApp({ memory: true, config: Object.assign({ demoPartner: true, secureCookies: false }, config) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  return server.address().port;
}

function req(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test('canonicalTarget is on only for a real https PUBLIC_BASE_URL', () => {
  assert.deepEqual(canonicalTarget('https://goody.day'), { origin: 'https://goody.day', host: 'goody.day' });
  assert.equal(canonicalTarget('http://goody.day'), null);
  assert.equal(canonicalTarget('https://localhost:3000'), null);
  assert.equal(canonicalTarget('https://127.0.0.1'), null);
  assert.equal(canonicalTarget(''), null);
});

test('old host and www get a 301 to the same path and query on PUBLIC_BASE_URL', async () => {
  const port = await start({ publicBaseUrl: 'https://goody.day' });
  const old = await req(port, { path: '/terms?x=1&y=two', headers: { host: 'goody-dfi5.onrender.com' } });
  assert.equal(old.status, 301);
  assert.equal(old.location, 'https://goody.day/terms?x=1&y=two');

  const www = await req(port, { path: '/', headers: { host: 'www.goody.day' } });
  assert.equal(www.status, 301);
  assert.equal(www.location, 'https://goody.day/');

  const head = await req(port, { method: 'HEAD', path: '/privacy', headers: { host: 'www.goody.day' } });
  assert.equal(head.status, 301);
  assert.equal(head.location, 'https://goody.day/privacy');

  // GET API calls and OAuth starts on the old host move too.
  const api = await req(port, { path: '/api/config', headers: { host: 'goody-dfi5.onrender.com' } });
  assert.equal(api.status, 301);
  assert.equal(api.location, 'https://goody.day/api/config');
});

test('x-forwarded-host is honored', async () => {
  const port = await start({ publicBaseUrl: 'https://goody.day' });
  const viaProxy = await req(port, { path: '/a?b=c', headers: { host: 'goody.day', 'x-forwarded-host': 'www.goody.day' } });
  assert.equal(viaProxy.status, 301);
  assert.equal(viaProxy.location, 'https://goody.day/a?b=c');
  const okProxy = await req(port, { path: '/api/config', headers: { host: 'internal:10000', 'x-forwarded-host': 'goody.day' } });
  assert.equal(okProxy.status, 200);
});

test('the real host, health, postbacks, and non-GET requests are never redirected', async () => {
  const port = await start({ publicBaseUrl: 'https://goody.day' });
  assert.equal((await req(port, { path: '/api/config', headers: { host: 'goody.day' } })).status, 200);
  assert.equal((await req(port, { path: '/api/health', headers: { host: 'goody-dfi5.onrender.com' } })).status, 200);

  const pb = await req(port, { path: '/postback/demo?uid=nobody&txid=t1&payout=1&status=paid&sig=bad', headers: { host: 'goody-dfi5.onrender.com' } });
  assert.notEqual(pb.status, 301);

  const post = await req(port, {
    method: 'POST',
    path: '/api/auth/login',
    headers: { host: 'goody-dfi5.onrender.com', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@example.com', password: 'nope12345' })
  });
  assert.notEqual(post.status, 301);
  assert.equal(post.status, 401);

  const pbPost = await req(port, { method: 'POST', path: '/postback/adgem', headers: { host: 'www.goody.day', 'content-type': 'application/json' }, body: '{}' });
  assert.notEqual(pbPost.status, 301);
});

test('does nothing on localhost, http, raw IPs, or when turned off', async () => {
  const local = await start({ publicBaseUrl: 'http://localhost:3000' });
  assert.equal((await req(local, { path: '/api/config', headers: { host: 'goody-dfi5.onrender.com' } })).status, 200);

  const port = await start({ publicBaseUrl: 'https://goody.day' });
  assert.equal((await req(port, { path: '/api/config', headers: { host: '127.0.0.1:' + port } })).status, 200);
  assert.equal((await req(port, { path: '/api/config', headers: { host: '10.0.0.5:10000' } })).status, 200);
  assert.equal((await req(port, { path: '/api/config', headers: { host: 'localhost' } })).status, 200);

  const off = await start({ publicBaseUrl: 'https://goody.day', canonicalRedirect: false });
  assert.equal((await req(off, { path: '/api/config', headers: { host: 'www.goody.day' } })).status, 200);
});

test('Google start on the real host uses the goody.day callback', async () => {
  const port = await start({
    publicBaseUrl: 'https://goody.day',
    googleClientId: 'gid.apps.googleusercontent.com',
    googleClientSecret: 'test-only'
  });
  const r = await req(port, { path: '/api/auth/google/start?agree=1&age=1', headers: { host: 'goody.day' } });
  assert.equal(r.status, 302);
  assert.equal(new URL(r.location).searchParams.get('redirect_uri'), 'https://goody.day/api/auth/google/callback');
});
