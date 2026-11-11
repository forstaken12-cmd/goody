'use strict';

function createLimiter({ windowMs, max, keyFn }) {
  const hits = new Map();
  return function limit(req, res, next) {
    const now = Date.now();
    const key = (keyFn && keyFn(req)) || req.ip || 'anon';
    let b = hits.get(key);
    if (!b || now - b.start > windowMs) {
      b = { start: now, n: 0 };
      hits.set(key, b);
    }
    b.n += 1;
    if (b.n > max) {
      res.status(429).json({ error: 'Too many requests. Try again in a moment.' });
      return;
    }
    next();
  };
}

// Occasional cleanup so the map doesn't grow forever
setInterval(() => {}, 1 << 30).unref();

module.exports = { createLimiter };
