'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, exportPKCS8, SignJWT, jwtVerify, createLocalJWKSet } = require('jose');
const { createApp } = require('../server/app');
const oauth = require('../server/lib/oauth');

let googleKeys, appleKeys, appleSecretKeys;
let enabledApp, enabledServer, enabledBase;
let plainApp, plainServer, plainBase;

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

async function mintIdToken(privateKey, { alg, kid, iss, aud, sub, email, emailVerified, nonce, extra }) {
  const payload = Object.assign({
    email,
    email_verified: emailVerified,
    nonce
  }, extra || {});
  if (email == null) delete payload.email;
  if (emailVerified == null) delete payload.email_verified;
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
  gJwk.kid = 'test-google';
  gJwk.alg = 'RS256';
  gJwk.use = 'sig';
  googleKeys.jwks = createLocalJWKSet({ keys: [gJwk] });
  googleKeys.kid = 'test-google';

  appleKeys = await generateKeyPair('ES256', { extractable: true });
  const aJwk = await exportJWK(appleKeys.publicKey);
  aJwk.kid = 'test-apple';
  aJwk.alg = 'ES256';
  aJwk.use = 'sig';
  appleKeys.jwks = createLocalJWKSet({ keys: [aJwk] });
  appleKeys.kid = 'test-apple';

  appleSecretKeys = await generateKeyPair('ES256', { extractable: true });
  appleSecretKeys.pem = await exportPKCS8(appleSecretKeys.privateKey);

  const oauthCfg = {
    demoPartner: true,
    publicBaseUrl: 'http://127.0.0.1',
    secureCookies: false,
    googleClientId: 'google-client-test.apps.googleusercontent.com',
    googleClientSecret: 'google-secret-test',
    appleClientId: 'com.goody.test.web',
    appleTeamId: 'TEAM12TEST',
    appleKeyId: 'KEY12TEST',
    applePrivateKey: appleSecretKeys.pem,
    appleDomainAssociation: 'apple-domain-verify-token'
  };

  async function oauthFetch(url, init) {
    const u = String(url);
    const body = new URLSearchParams((init && init.body) || '');
    const rawCode = body.get('code') || '';
    const splitAt = rawCode.indexOf(':');
    const kind = splitAt === -1 ? rawCode : rawCode.slice(0, splitAt);
    const nonce = splitAt === -1 ? '' : rawCode.slice(splitAt + 1);
    if (u.includes('oauth2.googleapis.com/token')) {
      const id_token = await mintIdToken(googleKeys.privateKey, {
        alg: 'RS256',
        kid: googleKeys.kid,
        iss: 'https://accounts.google.com',
        aud: oauthCfg.googleClientId,
        sub: kind === 'code-other' ? 'google-sub-other' : 'google-sub-1',
        email: kind === 'code-other' ? 'other@example.com' : 'alex@example.com',
        emailVerified: true,
        nonce
      });
      return {
        ok: true,
        json: async () => ({ id_token, access_token: 'g-access', token_type: 'Bearer' })
      };
    }
    if (u.includes('appleid.apple.com/auth/token')) {
      const id_token = await mintIdToken(appleKeys.privateKey, {
        alg: 'ES256',
        kid: appleKeys.kid,
        iss: 'https://appleid.apple.com',
        aud: oauthCfg.appleClientId,
        sub: kind === 'apple-code-relay' ? 'apple-sub-relay' : 'apple-sub-1',
        email: kind === 'apple-code-relay' ? undefined : 'alex@example.com',
        emailVerified: kind === 'apple-code-relay' ? undefined : 'true',
        nonce
      });
      return {
        ok: true,
        json: async () => ({ id_token, access_token: 'a-access', token_type: 'Bearer' })
      };
    }
    return { ok: false, json: async () => ({ error: 'unexpected fetch ' + u }) };
  }

  enabledApp = await createApp({
    memory: true,
    config: oauthCfg,
    oauthFetch,
    oauthGoogleJwks: googleKeys.jwks,
    oauthAppleJwks: appleKeys.jwks
  });
  enabledServer = await listen(enabledApp);
  enabledBase = `http://127.0.0.1:${enabledServer.address().port}`;

  plainApp = await createApp({
    memory: true,
    config: { demoPartner: true, publicBaseUrl: 'http://127.0.0.1', secureCookies: false }
  });
  plainServer = await listen(plainApp);
  plainBase = `http://127.0.0.1:${plainServer.address().port}`;
});

after(() => {
  if (enabledServer) enabledServer.close();
  if (plainServer) plainServer.close();
});

test('providers are hidden when env vars are missing', async () => {
  const res = await fetch(plainBase + '/api/auth/providers');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { google: false, apple: false });
  const cfg = await (await fetch(plainBase + '/api/config')).json();
  assert.deepEqual(cfg.oauth, { google: false, apple: false });
  const start = await fetch(plainBase + '/api/auth/google/start?agree=1&age=1');
  assert.equal(start.status, 503);
  const apple = await fetch(plainBase + '/api/auth/apple/start?agree=1&age=1');
  assert.equal(apple.status, 503);
  const domain = await fetch(plainBase + '/.well-known/apple-developer-domain-association.txt');
  assert.equal(domain.status, 404);
});

test('signup and login pages still show the official button labels when providers are off', async () => {
  const html = await (await fetch(plainBase + '/')).text();
  assert.match(html, /Continue with Google/);
  assert.match(html, /Continue with Apple/);
  assert.match(html, /Coming soon/);
  assert.match(html, /or use your email/);
  assert.match(html, /Create account with email/);
});

test('Apple client-secret JWT uses ES256, team id, key id, and Services ID', async () => {
  const token = await oauth.createAppleClientSecret({
    applePrivateKey: appleSecretKeys.pem.replace(/\n/g, '\\n'),
    appleKeyId: 'KEY12TEST',
    appleTeamId: 'TEAM12TEST',
    appleClientId: 'com.goody.test.web'
  });
  const { payload, protectedHeader } = await jwtVerify(token, appleSecretKeys.publicKey, {
    issuer: 'TEAM12TEST',
    audience: 'https://appleid.apple.com',
    subject: 'com.goody.test.web'
  });
  assert.equal(protectedHeader.alg, 'ES256');
  assert.equal(protectedHeader.kid, 'KEY12TEST');
  assert.equal(payload.iss, 'TEAM12TEST');
  assert.equal(payload.aud, 'https://appleid.apple.com');
  assert.equal(payload.sub, 'com.goody.test.web');
});

test('start requires age and terms, then redirects to the provider', async () => {
  const bad = await fetch(enabledBase + '/api/auth/google/start', { redirect: 'manual' });
  assert.equal(bad.status, 400);
  const res = await fetch(enabledBase + '/api/auth/google/start?agree=1&age=1', { redirect: 'manual' });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('client_id'), 'google-client-test.apps.googleusercontent.com');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.equal(loc.searchParams.get('scope'), 'openid email profile');
  assert.equal(loc.searchParams.get('redirect_uri'), 'http://127.0.0.1/api/auth/google/callback');
  assert.ok(loc.searchParams.get('state'));
  assert.ok(loc.searchParams.get('nonce'));

  const apple = await fetch(enabledBase + '/api/auth/apple/start?agree=true&age=on', { redirect: 'manual' });
  assert.equal(apple.status, 302);
  const aloc = new URL(apple.headers.get('location'));
  assert.equal(aloc.origin + aloc.pathname, 'https://appleid.apple.com/auth/authorize');
  assert.equal(aloc.searchParams.get('response_mode'), 'form_post');
  assert.equal(aloc.searchParams.get('response_type'), 'code id_token');
  assert.equal(aloc.searchParams.get('redirect_uri'), 'http://127.0.0.1/api/auth/apple/callback');
  assert.equal(aloc.searchParams.get('client_id'), 'com.goody.test.web');
});

test('Google callback creates a verified session and links later by email', async () => {
  const start = await fetch(enabledBase + '/api/auth/google/start?agree=1&age=1', { redirect: 'manual' });
  const loc = new URL(start.headers.get('location'));
  const cb = await fetch(
    enabledBase + '/api/auth/google/callback?code=' + encodeURIComponent('code-1:' + loc.searchParams.get('nonce')) + '&state=' + loc.searchParams.get('state'),
    { redirect: 'manual' }
  );
  assert.equal(cb.status, 302);
  assert.equal(new URL(cb.headers.get('location'), enabledBase).pathname, '/');
  const cookie = readCookie(cb);
  assert.ok(cookie);
  const me = await fetch(enabledBase + '/api/me', { headers: { cookie: 'goody_session=' + cookie } });
  assert.equal(me.status, 200);
  const user = await me.json();
  assert.equal(user.email, 'alex@example.com');
  assert.equal(user.emailVerified, true);
  assert.equal(user.googleLinked, true);

  // Same email via Apple should attach to the same account
  const astart = await fetch(enabledBase + '/api/auth/apple/start?agree=1&age=1', { redirect: 'manual' });
  const aloc = new URL(astart.headers.get('location'));
  const acb = await fetch(enabledBase + '/api/auth/apple/callback', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: 'apple-code-1:' + aloc.searchParams.get('nonce'),
      state: aloc.searchParams.get('state')
    }).toString()
  });
  assert.equal(acb.status, 302);
  const acookie = readCookie(acb);
  const me2 = await (await fetch(enabledBase + '/api/me', { headers: { cookie: 'goody_session=' + acookie } })).json();
  assert.equal(me2.email, 'alex@example.com');
  assert.equal(me2.publicId, user.publicId);
  assert.equal(me2.appleLinked, true);
  assert.equal(me2.googleLinked, true);
});

test('Apple form_post with no email still signs in on a later visit by Apple id', async () => {
  const start = await fetch(enabledBase + '/api/auth/apple/start?agree=1&age=1', { redirect: 'manual' });
  const loc = new URL(start.headers.get('location'));
  const first = await fetch(enabledBase + '/api/auth/apple/callback', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: 'apple-code-relay:' + loc.searchParams.get('nonce'),
      state: loc.searchParams.get('state')
    }).toString()
  });
  const cookie = readCookie(first);
  const me = await (await fetch(enabledBase + '/api/me', { headers: { cookie: 'goody_session=' + cookie } })).json();
  assert.equal(me.appleLinked, true);
  assert.equal(me.emailVerified, false);

  const start2 = await fetch(enabledBase + '/api/auth/apple/start?agree=1&age=1', { redirect: 'manual' });
  const loc2 = new URL(start2.headers.get('location'));
  const second = await fetch(enabledBase + '/api/auth/apple/callback', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: 'apple-code-relay:' + loc2.searchParams.get('nonce'),
      state: loc2.searchParams.get('state')
    }).toString()
  });
  const me2 = await (await fetch(enabledBase + '/api/me', {
    headers: { cookie: 'goody_session=' + readCookie(second) }
  })).json();
  assert.equal(me2.publicId, me.publicId);
});

test('expired or reused state is rejected', async () => {
  const start = await fetch(enabledBase + '/api/auth/google/start?agree=1&age=1', { redirect: 'manual' });
  const loc = new URL(start.headers.get('location'));
  const url = enabledBase + '/api/auth/google/callback?code=' + encodeURIComponent('code-other:' + loc.searchParams.get('nonce')) + '&state=' + loc.searchParams.get('state');
  const first = await fetch(url, { redirect: 'manual' });
  assert.equal(first.status, 302);
  assert.equal(new URL(first.headers.get('location'), enabledBase).pathname, '/');
  const again = await fetch(url, { redirect: 'manual' });
  const againUrl = new URL(again.headers.get('location'), enabledBase);
  assert.match(againUrl.searchParams.get('authError') || '', /expired|try again/i);
});

test('ID token with the wrong audience is rejected', async () => {
  const start = await fetch(enabledBase + '/api/auth/google/start?agree=1&age=1', { redirect: 'manual' });
  const loc = new URL(start.headers.get('location'));
  const badToken = await mintIdToken(googleKeys.privateKey, {
    alg: 'RS256',
    kid: googleKeys.kid,
    iss: 'https://accounts.google.com',
    aud: 'someone-else',
    sub: 'google-sub-bad',
    email: 'bad@example.com',
    emailVerified: true,
    nonce: loc.searchParams.get('nonce')
  });
  // Swap the fetch just for this call by verifying unit-level instead
  await assert.rejects(
    () => oauth.verifyGoogleIdToken(badToken, {
      audience: 'google-client-test.apps.googleusercontent.com',
      nonce: loc.searchParams.get('nonce'),
      jwks: googleKeys.jwks
    }),
    /could not be checked/i
  );
});

test('domain association file is served when configured', async () => {
  const res = await fetch(enabledBase + '/.well-known/apple-developer-domain-association.txt');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'apple-domain-verify-token');
});

test('email+password account with verified email can be linked to Google', async () => {
  const { openDb } = require('../server/db');
  const auth = require('../server/lib/auth');
  const db = await openDb({ memory: true });
  const created = await auth.signup(db, {
    email: 'sam@example.com',
    password: 'password12',
    agreeTerms: true,
    ageConfirm: true
  });
  await assert.rejects(
    () => auth.loginWithOauth(db, {
      provider: 'google',
      subject: 'google-sam',
      email: 'sam@example.com',
      emailVerified: false,
      agreeTerms: true,
      ageConfirm: true
    }),
    /already has an account/i
  );
  await auth.markVerified(db, created.user.id);
  const linked = await auth.loginWithOauth(db, {
    provider: 'google',
    subject: 'google-sam',
    email: 'sam@example.com',
    emailVerified: true,
    agreeTerms: true,
    ageConfirm: true
  });
  assert.equal(linked.user.public_id, created.user.public_id);
  assert.equal(linked.user.google_id, 'google-sam');
  assert.ok(linked.user.email_verified_at);
});
