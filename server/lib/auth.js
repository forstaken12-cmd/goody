'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { isoNow } = require('./money');
const policy = require('./policy');

const BCRYPT_ROUNDS = 10;
const SESSION_DAYS = 30;
const VERIFY_HOURS = 24;
const RESET_HOURS = 1;
const MIN_PASSWORD = 8;
const COOKIE = 'goody_session';

function newId(prefix) {
  return (prefix || '') + crypto.randomBytes(12).toString('hex');
}

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function validEmail(email) {
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email);
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD && password.length <= 200;
}

async function findById(db, id) {
  if (!id) return undefined;
  return db.get('SELECT * FROM users WHERE id = ?', [id]);
}

async function findByPublicId(db, publicId) {
  if (!publicId) return undefined;
  return db.get('SELECT * FROM users WHERE public_id = ?', [publicId]);
}

async function findByEmail(db, email) {
  const e = normalizeEmail(email);
  if (!e) return undefined;
  return db.get('SELECT * FROM users WHERE email = ?', [e]);
}

async function findSession(db, token) {
  if (!token) return undefined;
  const row = await db.get('SELECT * FROM sessions WHERE token = ?', [token]);
  if (!row) return undefined;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    await db.run('DELETE FROM sessions WHERE token = ?', [token]);
    return undefined;
  }
  return row;
}

function cookieToken(req) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return '';
  const parts = String(raw).split(';');
  for (const p of parts) {
    const s = p.trim();
    if (s.startsWith(COOKIE + '=')) return decodeURIComponent(s.slice(COOKIE.length + 1));
  }
  return '';
}

function bearer(req) {
  const h = req.get ? (req.get('authorization') || '') : '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return (m && m[1]) || '';
}

function sessionTokenFromReq(req) {
  return cookieToken(req) || bearer(req) || '';
}

function cookieOptions(cfg) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!(cfg && cfg.secureCookies),
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  };
}

function setSessionCookie(res, token, cfg) {
  res.cookie(COOKIE, token, cookieOptions(cfg));
}

function clearSessionCookie(res, cfg) {
  res.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: !!(cfg && cfg.secureCookies) });
}

async function createSession(db, userId, req) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = isoNow();
  const exp = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const ua = req && req.get ? (req.get('user-agent') || '').slice(0, 250) : '';
  const ip = req && (req.ip || '') || '';
  await db.run(
    'INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [token, userId, now, exp, ua, ip]
  );
  return token;
}

async function destroySession(db, token) {
  if (!token) return;
  await db.run('DELETE FROM sessions WHERE token = ?', [token]);
}

async function touchUser(db, userId) {
  await db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', [isoNow(), userId]);
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

async function issueEmailToken(db, userId, type, hours) {
  const raw = crypto.randomBytes(24).toString('hex');
  const now = isoNow();
  const exp = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  await db.run(
    'INSERT INTO email_tokens (user_id, type, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [userId, type, hashToken(raw), exp, now]
  );
  return raw;
}

async function consumeEmailToken(db, raw, type) {
  if (!raw) return undefined;
  const row = await db.get(
    'SELECT * FROM email_tokens WHERE token_hash = ? AND type = ?',
    [hashToken(raw), type]
  );
  if (!row) return undefined;
  if (row.used_at) return undefined;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return undefined;
  await db.run('UPDATE email_tokens SET used_at = ? WHERE id = ?', [isoNow(), row.id]);
  return row;
}

function noteFingerprint(existing, fingerprint) {
  const fp = (fingerprint && String(fingerprint).slice(0, 80)) || '';
  if (!fp) return { device_fingerprint: existing && existing.device_fingerprint, device_note: existing && existing.device_note };
  if (!existing || !existing.device_fingerprint) {
    return { device_fingerprint: fp, device_note: existing && existing.device_note };
  }
  if (existing.device_fingerprint === fp) {
    return { device_fingerprint: existing.device_fingerprint, device_note: existing.device_note };
  }
  const note = (existing.device_note ? existing.device_note + ' | ' : '') +
    'Also seen from a second device on ' + isoNow();
  return { device_fingerprint: existing.device_fingerprint, device_note: note.slice(0, 500) };
}

async function signup(db, { email, password, agreeTerms, ageConfirm, fingerprint }, req) {
  const e = normalizeEmail(email);
  if (!validEmail(e)) throw Object.assign(new Error('Enter a real-looking email.'), { http: 400 });
  if (!validPassword(password)) throw Object.assign(new Error('Use a password with at least 8 characters.'), { http: 400 });
  if (!agreeTerms) throw Object.assign(new Error('Please agree to the Terms and Privacy Policy.'), { http: 400, code: 'NEED_AGREE' });
  if (!ageConfirm) throw Object.assign(new Error('You need to be ' + policy.MIN_AGE + ' or older to use Goody.'), { http: 400, code: 'NEED_AGREE' });
  const taken = await findByEmail(db, e);
  if (taken) throw Object.assign(new Error('That email already has an account. Try signing in.'), { http: 409 });

  const now = isoNow();
  const publicId = 'u_' + crypto.randomBytes(8).toString('hex');
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const fp = noteFingerprint(null, fingerprint);
  const r = await db.run(
    `INSERT INTO users (public_id, email, password_hash, agreed_terms_at, terms_version, age_confirmed, age_confirmed_min, device_fingerprint, device_note, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [publicId, e, passwordHash, now, policy.TERMS_VERSION, policy.MIN_AGE, fp.device_fingerprint || null, fp.device_note || null, now, now]
  );
  const user = await db.get('SELECT * FROM users WHERE id = ?', [r.lastInsertRowid]);
  await db.run('INSERT INTO streaks (user_id, current, best, last_date) VALUES (?, 0, 0, NULL)', [user.id]);
  const session = await createSession(db, user.id, req);
  const verifyToken = await issueEmailToken(db, user.id, 'verify', VERIFY_HOURS);
  return { user, session, verifyToken };
}

async function login(db, { email, password, fingerprint }, req) {
  const e = normalizeEmail(email);
  const user = await findByEmail(db, e);
  // Same message for missing user or bad password
  const bad = Object.assign(new Error('Email or password is not right.'), { http: 401 });
  if (!user || !user.password_hash) throw bad;
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) throw bad;
  const fp = noteFingerprint(user, fingerprint);
  if (fp.device_note !== user.device_note || fp.device_fingerprint !== user.device_fingerprint) {
    await db.run('UPDATE users SET device_fingerprint = ?, device_note = ?, last_seen_at = ? WHERE id = ?', [
      fp.device_fingerprint || null, fp.device_note || null, isoNow(), user.id
    ]);
  } else {
    await touchUser(db, user.id);
  }
  const session = await createSession(db, user.id, req);
  const fresh = await findById(db, user.id);
  return { user: fresh, session };
}

async function changePassword(db, userId, newPassword) {
  if (!validPassword(newPassword)) {
    throw Object.assign(new Error('Use a password with at least 8 characters.'), { http: 400 });
  }
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

async function markVerified(db, userId) {
  await db.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', [isoNow(), userId]);
  return findById(db, userId);
}

/** Save that this person ticked "old enough" and "I agree" for the current Terms. */
async function recordAgreement(db, userId) {
  await db.run(
    'UPDATE users SET agreed_terms_at = ?, terms_version = ?, age_confirmed = 1, age_confirmed_min = ? WHERE id = ?',
    [isoNow(), policy.TERMS_VERSION, policy.MIN_AGE, userId]
  );
  return findById(db, userId);
}

function publicUser(user) {
  if (!user) return null;
  return {
    publicId: user.public_id,
    email: user.email,
    emailVerified: !!user.email_verified_at,
    firstCashoutDone: !!user.first_cashout_at,
    googleLinked: !!user.google_id,
    appleLinked: !!user.apple_id,
    termsOk: policy.termsCurrent(user)
  };
}

function requireUser(db) {
  return async function (req, res, next) {
    try {
      const token = sessionTokenFromReq(req);
      const ses = await findSession(db, token);
      if (!ses) {
        res.status(401).json({ error: 'Please sign in.' });
        return;
      }
      const user = await findById(db, ses.user_id);
      if (!user) {
        res.status(401).json({ error: 'Please sign in.' });
        return;
      }
      req.user = user;
      req.sessionToken = token;
      next();
    } catch (e) {
      next(e);
    }
  };
}


async function findByGoogleId(db, sub) {
  if (!sub) return undefined;
  return db.get('SELECT * FROM users WHERE google_id = ?', [sub]);
}

async function findByAppleId(db, sub) {
  if (!sub) return undefined;
  return db.get('SELECT * FROM users WHERE apple_id = ?', [sub]);
}

/**
 * Sign in or create an account from a verified Google or Apple identity.
 * Links to an existing account when the verified email already belongs to one.
 */
async function loginWithOauth(db, { provider, subject, email, emailVerified, agreeTerms, ageConfirm, fingerprint }, req) {
  if (provider !== 'google' && provider !== 'apple') {
    throw Object.assign(new Error('Unknown sign-in method.'), { http: 400 });
  }
  if (!subject) throw Object.assign(new Error('Sign-in could not be checked. Please try again.'), { http: 401 });
  const col = provider === 'google' ? 'google_id' : 'apple_id';
  let user = provider === 'google'
    ? await findByGoogleId(db, subject)
    : await findByAppleId(db, subject);

  const e = normalizeEmail(email || '');

  if (!user && e) {
    const byEmail = await findByEmail(db, e);
    if (byEmail) {
      if (!emailVerified && !byEmail.email_verified_at) {
        throw Object.assign(new Error('That email already has an account. Sign in with your password, then you can link this sign-in.'), { http: 409 });
      }
      if (byEmail[col] && byEmail[col] !== subject) {
        throw Object.assign(new Error('That email is already used on another account.'), { http: 409 });
      }
      const fp = noteFingerprint(byEmail, fingerprint);
      const now = isoNow();
      await db.run(
        `UPDATE users SET ${col} = ?, email_verified_at = COALESCE(email_verified_at, ?), device_fingerprint = ?, device_note = ?, last_seen_at = ? WHERE id = ?`,
        [subject, emailVerified ? now : null, fp.device_fingerprint || null, fp.device_note || null, now, byEmail.id]
      );
      user = await findById(db, byEmail.id);
    }
  }

  if (!user) {
    if (!agreeTerms || !ageConfirm) {
      throw Object.assign(new Error(policy.agreeMessage()), { http: 400, code: 'NEED_AGREE' });
    }
    const now = isoNow();
    const publicId = 'u_' + crypto.randomBytes(8).toString('hex');
    const fp = noteFingerprint(null, fingerprint);
    const r = await db.run(
      `INSERT INTO users (public_id, email, password_hash, email_verified_at, agreed_terms_at, terms_version, age_confirmed, age_confirmed_min, device_fingerprint, device_note, google_id, apple_id, created_at, last_seen_at)
       VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [
        publicId,
        e || null,
        emailVerified ? now : null,
        now,
        policy.TERMS_VERSION,
        policy.MIN_AGE,
        fp.device_fingerprint || null,
        fp.device_note || null,
        provider === 'google' ? subject : null,
        provider === 'apple' ? subject : null,
        now,
        now
      ]
    );
    user = await db.get('SELECT * FROM users WHERE id = ?', [r.lastInsertRowid]);
    await db.run('INSERT INTO streaks (user_id, current, best, last_date) VALUES (?, 0, 0, NULL)', [user.id]);
  } else {
    // Returning people never need the boxes again. If they ticked them anyway
    // and their saved agreement is old (Terms version bump), save the new one.
    if (agreeTerms && ageConfirm && !policy.termsCurrent(user)) {
      await recordAgreement(db, user.id);
    }
    await touchUser(db, user.id);
  }

  const session = await createSession(db, user.id, req);
  return { user: await findById(db, user.id), session, linked: true };
}

module.exports = {
  recordAgreement,
  newId,
  COOKIE,
  MIN_PASSWORD,
  normalizeEmail,
  validEmail,
  validPassword,
  findById,
  findByPublicId,
  findByEmail,
  findSession,
  bearer,
  cookieToken,
  sessionTokenFromReq,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  destroySession,
  issueEmailToken,
  consumeEmailToken,
  signup,
  login,
  changePassword,
  markVerified,
  publicUser,
  requireUser,
  findByGoogleId,
  findByAppleId,
  loginWithOauth,
  hashToken,
  VERIFY_HOURS,
  RESET_HOURS
};
