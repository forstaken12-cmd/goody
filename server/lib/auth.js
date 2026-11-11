'use strict';

const crypto = require('crypto');
const { isoNow } = require('./money');

function newId(prefix) {
  return (prefix || '') + crypto.randomBytes(12).toString('hex');
}

function findByToken(db, token) {
  if (!token) return undefined;
  return db.get('SELECT * FROM users WHERE token = ?', [token]);
}

function findByPublicId(db, publicId) {
  if (!publicId) return undefined;
  return db.get('SELECT * FROM users WHERE public_id = ?', [publicId]);
}

function findByDevice(db, deviceId) {
  if (!deviceId) return undefined;
  return db.get('SELECT * FROM users WHERE device_id = ?', [deviceId]);
}

function getOrCreateUser(db, deviceId) {
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 80) {
    throw Object.assign(new Error('Need a device id'), { http: 400 });
  }
  let user = findByDevice(db, deviceId);
  if (user) {
    db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', [isoNow(), user.id]);
    return findByDevice(db, deviceId);
  }
  const now = isoNow();
  const publicId = 'u_' + crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  db.run(
    'INSERT INTO users (public_id, device_id, token, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    [publicId, deviceId, token, now, now]
  );
  user = findByDevice(db, deviceId);
  db.run('INSERT INTO streaks (user_id, current, best, last_date) VALUES (?, 0, 0, NULL)', [user.id]);
  return user;
}

function bearer(req) {
  const h = req.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return (m && m[1]) || req.query.token || (req.body && req.body.token) || '';
}

function requireUser(db) {
  return function (req, res, next) {
    const user = findByToken(db, bearer(req));
    if (!user) {
      res.status(401).json({ error: 'Please sign in again.' });
      return;
    }
    req.user = user;
    next();
  };
}

module.exports = { newId, findByToken, findByPublicId, findByDevice, getOrCreateUser, bearer, requireUser };
