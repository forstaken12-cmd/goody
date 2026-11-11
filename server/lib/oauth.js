'use strict';

const crypto = require('crypto');
const { SignJWT, jwtVerify, createRemoteJWKSet, importPKCS8 } = require('jose');
const { isoNow } = require('./money');

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const APPLE_AUTH = 'https://appleid.apple.com/auth/authorize';
const APPLE_TOKEN = 'https://appleid.apple.com/auth/token';
const APPLE_JWKS = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

function present(v) {
  return v != null && String(v).trim() !== '';
}

function googleEnabled(cfg) {
  return present(cfg.googleClientId) && present(cfg.googleClientSecret);
}

function appleEnabled(cfg) {
  return present(cfg.appleClientId) && present(cfg.appleTeamId) &&
    present(cfg.appleKeyId) && present(cfg.applePrivateKey);
}

function providersStatus(cfg) {
  return { google: googleEnabled(cfg), apple: appleEnabled(cfg) };
}

function baseUrl(cfg) {
  return String(cfg.publicBaseUrl || 'http://localhost:3000').replace(/\/$/, '');
}

function googleRedirectUri(cfg) {
  return baseUrl(cfg) + '/api/auth/google/callback';
}

function appleRedirectUri(cfg) {
  return baseUrl(cfg) + '/api/auth/apple/callback';
}

function normalizePem(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\\n/g, '\n');
  return s.trim();
}

async function createAppleClientSecret(cfg) {
  const pem = normalizePem(cfg.applePrivateKey);
  const key = await importPKCS8(pem, 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: cfg.appleKeyId })
    .setIssuer(cfg.appleTeamId)
    .setIssuedAt()
    .setExpirationTime('15m')
    .setAudience(APPLE_ISSUER)
    .setSubject(cfg.appleClientId)
    .sign(key);
}

function buildGoogleAuthUrl(cfg, { state, nonce }) {
  const q = new URLSearchParams({
    client_id: cfg.googleClientId,
    redirect_uri: googleRedirectUri(cfg),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    access_type: 'online',
    prompt: 'select_account'
  });
  return GOOGLE_AUTH + '?' + q.toString();
}

function buildAppleAuthUrl(cfg, { state, nonce }) {
  const q = new URLSearchParams({
    client_id: cfg.appleClientId,
    redirect_uri: appleRedirectUri(cfg),
    response_type: 'code id_token',
    response_mode: 'form_post',
    scope: 'name email',
    state,
    nonce
  });
  return APPLE_AUTH + '?' + q.toString();
}

async function exchangeGoogleCode(cfg, code, { fetchFn } = {}) {
  const fetchImpl = fetchFn || fetch;
  const res = await fetchImpl(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      redirect_uri: googleRedirectUri(cfg),
      grant_type: 'authorization_code'
    }).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) {
    throw Object.assign(new Error('Google could not finish sign-in.'), { http: 401, detail: data.error });
  }
  return data;
}

async function exchangeAppleCode(cfg, code, { fetchFn, clientSecret } = {}) {
  const fetchImpl = fetchFn || fetch;
  const secret = clientSecret || (await createAppleClientSecret(cfg));
  const res = await fetchImpl(APPLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.appleClientId,
      client_secret: secret,
      redirect_uri: appleRedirectUri(cfg),
      grant_type: 'authorization_code'
    }).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) {
    throw Object.assign(new Error('Apple could not finish sign-in.'), { http: 401, detail: data.error });
  }
  return data;
}

function googleJwks() {
  return createRemoteJWKSet(new URL(GOOGLE_JWKS));
}

function appleJwks() {
  return createRemoteJWKSet(new URL(APPLE_JWKS));
}

function emailVerifiedClaim(payload) {
  const v = payload && payload.email_verified;
  return v === true || v === 'true' || v === '1';
}

async function verifyGoogleIdToken(idToken, { audience, nonce, jwks } = {}) {
  const key = jwks || googleJwks();
  let lastErr;
  for (const issuer of GOOGLE_ISSUERS) {
    try {
      const { payload } = await jwtVerify(idToken, key, { issuer, audience });
      if (nonce && payload.nonce !== nonce) {
        throw Object.assign(new Error('Sign-in could not be checked. Please try again.'), { http: 401 });
      }
      return payload;
    } catch (e) {
      lastErr = e;
    }
  }
  throw Object.assign(new Error('Google sign-in could not be checked.'), { http: 401, cause: lastErr });
}

async function verifyAppleIdToken(idToken, { audience, nonce, jwks } = {}) {
  const key = jwks || appleJwks();
  const { payload } = await jwtVerify(idToken, key, { issuer: APPLE_ISSUER, audience });
  if (nonce && payload.nonce !== nonce) {
    throw Object.assign(new Error('Sign-in could not be checked. Please try again.'), { http: 401 });
  }
  return payload;
}

async function createOauthState(db, { provider, agree, age, fingerprint }) {
  const state = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const now = isoNow();
  const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await db.run(
    `INSERT INTO oauth_states (id, provider, nonce, agree, age, fingerprint, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [state, provider, nonce, agree ? 1 : 0, age ? 1 : 0, fingerprint || null, exp, now]
  );
  return { state, nonce, expiresAt: exp };
}

async function takeOauthState(db, state, provider) {
  if (!state) return undefined;
  const row = await db.get('SELECT * FROM oauth_states WHERE id = ?', [state]);
  if (!row) return undefined;
  await db.run('DELETE FROM oauth_states WHERE id = ?', [state]);
  if (row.provider !== provider) return undefined;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return undefined;
  return row;
}

function claimsFromPayload(provider, payload) {
  const email = payload.email ? String(payload.email).trim().toLowerCase() : '';
  return {
    provider,
    subject: String(payload.sub || ''),
    email: email || null,
    emailVerified: !!(email && emailVerifiedClaim(payload))
  };
}

module.exports = {
  GOOGLE_AUTH, GOOGLE_TOKEN, GOOGLE_JWKS, GOOGLE_ISSUERS,
  APPLE_AUTH, APPLE_TOKEN, APPLE_JWKS, APPLE_ISSUER,
  googleEnabled, appleEnabled, providersStatus,
  googleRedirectUri, appleRedirectUri, normalizePem,
  createAppleClientSecret, buildGoogleAuthUrl, buildAppleAuthUrl,
  exchangeGoogleCode, exchangeAppleCode,
  verifyGoogleIdToken, verifyAppleIdToken,
  createOauthState, takeOauthState, claimsFromPayload,
  emailVerifiedClaim
};
