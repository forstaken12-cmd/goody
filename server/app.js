'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const { openDb } = require('./db');
const { creditFromPartner, ptsToUsd, usdToPts, money, isoNow } = require('./lib/money');
const ledger = require('./lib/ledger');
const { verifyAndParse, signGeneric } = require('./lib/postback');
const { getOrCreateUser, findByPublicId, findByToken, requireUser, bearer } = require('./lib/auth');
const { createLimiter } = require('./lib/rateLimit');
const { listOffers, findOffer } = require('./demo/catalog');
const { createSimulator } = require('./demo/simulator');
const goals = require('./lib/goals');

const PUBLIC = path.join(__dirname, '..', 'public');

function offerView(o, sharePct, pointUsd) {
  const parts = creditFromPartner(o.partnerUsd, sharePct, pointUsd);
  const view = {
    id: o.id,
    name: o.name,
    task: o.task,
    category: o.category,
    type: o.type,
    minutes: o.minutes,
    difficulty: o.difficulty,
    badge: o.badge || null,
    steps: o.steps || null,
    questions: o.questions || null,
    createdAt: o.createdAt,
    partnerUsd: o.partnerUsd,
    points: parts.points,
    usd: parts.userUsd
  };
  if (o.milestones) {
    view.milestones = o.milestones.map((m) => {
      const p = creditFromPartner(m.partnerUsd, sharePct, pointUsd);
      return { id: m.id, minutes: m.minutes, points: p.points, usd: p.userUsd, partnerUsd: m.partnerUsd };
    });
  }
  return view;
}

function methodMinUsd(cfg, method, isFirst) {
  if (isFirst) return cfg.firstCashoutUsd;
  return cfg.mins[method] || cfg.mins.lightning;
}

function validDestination(method, dest) {
  if (!dest || typeof dest !== 'string') return false;
  const s = dest.trim();
  if (method === 'lightning') {
    if (/^ln(bc|tb|bcrt|url)?[0-9a-z]+$/i.test(s) && s.length > 10) return true;
    return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(s);
  }
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(s);
}

async function createApp(opts) {
  opts = opts || {};
  const cfg = Object.assign({}, config, opts.config || {});
  if (opts.config) {
    cfg.partners = Object.assign({}, config.partners, (opts.config && opts.config.partners) || {});
    if (opts.config.partners && opts.config.partners.demo) {
      cfg.partners.demo = Object.assign({}, config.partners.demo, opts.config.partners.demo);
    }
  }
  const db = opts.db || (await openDb({ path: opts.dbPath || cfg.dbPath, memory: opts.memory }));

  function ingest({ partnerKey, req, query }) {
    const partnerCfg = cfg.partners[partnerKey];
    if (!partnerCfg) {
      const err = Object.assign(new Error('Unknown partner'), { http: 404 });
      throw err;
    }
    const fakeReq = req || {
      query: query || {},
      body: {},
      originalUrl: '/postback/' + partnerKey + '?' + new URLSearchParams(query || {}).toString(),
      protocol: 'http',
      get(h) { return h.toLowerCase() === 'host' ? 'localhost' : undefined; },
      headers: {}
    };
    if (!req && query) fakeReq.query = query;
    const result = verifyAndParse(fakeReq, partnerCfg, cfg.publicBaseUrl);
    if (!result.ok) {
      throw Object.assign(new Error(result.reason || 'bad postback'), { http: result.http || 403, detail: result });
    }
    const user = findByPublicId(db, result.fields.uid);
    if (!user) {
      throw Object.assign(new Error('unknown user'), { http: 400, code: 'NO_USER' });
    }
    const source = result.fields.sourceHint || 'offer';
    const applied = ledger.applyPostback(db, {
      userId: user.id,
      partner: partnerKey,
      txId: result.fields.txid,
      offerId: result.fields.offerId,
      source,
      partnerUsd: result.fields.partnerUsd,
      status: result.fields.status,
      note: (query && query.note) || (result.body && result.body.note) || null,
      sharePct: cfg.sharePct,
      pointUsd: cfg.pointUsd
    });
    return { ok: true, ...applied, fields: result.fields };
  }

  const sim = createSimulator({ config: cfg, ingest, db });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; }
  }));
  app.use(express.urlencoded({ extended: false, verify: (req, _res, buf) => { req.rawBody = buf; } }));

  const apiLimit = createLimiter({ windowMs: 60_000, max: 180, keyFn: (r) => r.ip + ':' + (bearer(r) || '') });
  const cashLimit = createLimiter({ windowMs: 60_000, max: 8, keyFn: (r) => r.ip + ':' + (bearer(r) || '') });
  const sessionLimit = createLimiter({ windowMs: 60_000, max: 30, keyFn: (r) => r.ip });
  const postbackLimit = createLimiter({ windowMs: 60_000, max: 600, keyFn: (r) => r.ip });

  app.use('/api', apiLimit);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, demo: cfg.demoPartner });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      demo: cfg.demoPartner,
      sharePct: cfg.sharePct,
      pointUsd: cfg.pointUsd,
      firstCashoutUsd: cfg.firstCashoutUsd,
      mins: cfg.mins,
      tz: cfg.tz
    });
  });

  app.post('/api/session', sessionLimit, (req, res) => {
    try {
      const deviceId = (req.body && req.body.deviceId) || '';
      const user = getOrCreateUser(db, String(deviceId));
      const bal = ledger.balanceOf(db, user.id);
      res.json({
        token: user.token,
        publicId: user.public_id,
        firstCashoutDone: !!user.first_cashout_at,
        balance: bal
      });
    } catch (e) {
      res.status(e.http || 400).json({ error: e.message });
    }
  });

  const auth = requireUser(db);

  function mePayload(user) {
    const bal = ledger.balanceOf(db, user.id);
    const streak = goals.getStreak(db, user.id, cfg.tz);
    const daily = goals.computeGoals(db, user.id, cfg.tz);
    return {
      publicId: user.public_id,
      firstCashoutDone: !!user.first_cashout_at,
      firstCashoutUsd: cfg.firstCashoutUsd,
      balance: bal,
      availableUsd: ptsToUsd(bal.available, cfg.pointUsd),
      pendingUsd: ptsToUsd(bal.pending, cfg.pointUsd),
      streak,
      goals: daily,
      demo: cfg.demoPartner,
      sharePct: cfg.sharePct,
      pointUsd: cfg.pointUsd,
      mins: cfg.mins
    };
  }

  app.get('/api/me', auth, (req, res) => {
    res.json(mePayload(req.user));
  });

  app.get('/api/offers', auth, (req, res) => {
    const category = req.query.category || 'all';
    const sort = req.query.sort || 'highest';
    const list = listOffers({ category, sort }).map((o) => offerView(o, cfg.sharePct, cfg.pointUsd));
    res.json({ offers: list });
  });

  app.get('/api/offers/:id', auth, (req, res) => {
    const o = findOffer(req.params.id);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    const prog = db.get('SELECT * FROM offer_progress WHERE user_id = ? AND offer_id = ?', [req.user.id, o.id]);
    res.json({ offer: offerView(o, cfg.sharePct, cfg.pointUsd), progress: prog || null });
  });

  app.post('/api/offers/:id/start', auth, (req, res) => {
    if (!cfg.demoPartner) return res.status(403).json({ error: 'Demo partner is off. Real offerwalls will start from their own pages.' });
    const o = findOffer(req.params.id);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    try {
      if (o.type === 'playtime') {
        const r = sim.play(req.user, o, 0);
        return res.json({ ok: true, type: 'playtime', ...r, offer: offerView(o, cfg.sharePct, cfg.pointUsd) });
      }
      const outcome = req.body && req.body.outcome;
      const r = sim.startInstall(req.user, o, { outcome: outcome || undefined });
      res.json({ ok: true, type: o.type, ...r });
    } catch (e) {
      res.status(e.http || 400).json({ error: e.message });
    }
  });

  app.post('/api/offers/:id/play', auth, (req, res) => {
    if (!cfg.demoPartner) return res.status(403).json({ error: 'Demo partner is off.' });
    const o = findOffer(req.params.id);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    try {
      const minutes = Number((req.body && req.body.minutes) || 0);
      const r = sim.play(req.user, o, minutes);
      res.json({ ok: true, ...r, offer: offerView(o, cfg.sharePct, cfg.pointUsd) });
    } catch (e) {
      res.status(e.http || 400).json({ error: e.message });
    }
  });

  app.get('/api/history', auth, (req, res) => {
    const status = req.query.status || 'all';
    const rows = ledger.history(db, req.user.id, status).map((r) => ({
      id: r.id,
      type: r.entry_type,
      status: r.status,
      source: r.source,
      partner: r.partner,
      offerId: r.offer_id,
      points: r.points,
      usd: r.user_usd,
      note: r.note,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
    res.json({ entries: rows, balance: ledger.balanceOf(db, req.user.id) });
  });

  app.post('/api/checkin', auth, (req, res) => {
    const result = goals.applyCheckin(db, req.user, {
      tz: cfg.tz,
      fireBonus: cfg.demoPartner ? (info) => sim.bonus(info) : null
    });
    if (cfg.demoPartner) goals.maybeGoalBonus(db, req.user, { tz: cfg.tz, fireBonus: (info) => sim.bonus(info) });
    res.json({ ok: true, ...result, me: mePayload(req.user) });
  });

  app.get('/api/goals', auth, (req, res) => {
    if (cfg.demoPartner) goals.maybeGoalBonus(db, req.user, { tz: cfg.tz, fireBonus: (info) => sim.bonus(info) });
    res.json({ streak: goals.getStreak(db, req.user.id, cfg.tz), goals: goals.computeGoals(db, req.user.id, cfg.tz) });
  });

  app.post('/api/cashout', auth, cashLimit, (req, res) => {
    const method = (req.body && req.body.method) || 'lightning';
    const dest = ((req.body && req.body.destination) || '').trim();
    if (!['lightning', 'paypal', 'gift'].includes(method)) {
      return res.status(400).json({ error: 'Pick Bitcoin, PayPal, or a gift card.' });
    }
    if (!validDestination(method, dest)) {
      return res.status(400).json({ error: 'Enter a real-looking address or email.' });
    }
    const bal = ledger.balanceOf(db, req.user.id);
    const isFirst = !req.user.first_cashout_at;
    const minUsd = methodMinUsd(cfg, method, isFirst);
    const minPts = usdToPts(minUsd, cfg.pointUsd);
    let amt = Math.floor(Number((req.body && req.body.points) != null ? req.body.points : bal.available));
    if (!Number.isFinite(amt) || amt <= 0) amt = bal.available;
    if (amt > bal.available) {
      return res.status(400).json({ error: 'You do not have that many points.' });
    }
    if (amt < minPts) {
      return res.status(400).json({
        error: isFirst
          ? `Your first cash out needs ${minPts} points ($${minUsd.toFixed(2)}).`
          : `This way needs ${minPts} points.`
      });
    }
    const usd = ptsToUsd(amt, cfg.pointUsd);
    const debit = ledger.holdDebit(db, {
      userId: req.user.id,
      source: 'cashout',
      points: amt,
      usd,
      note: method + ' · ' + dest
    });
    const now = isoNow();
    const r = db.run(
      `INSERT INTO cashouts (user_id, method, destination, points, usd, is_first, status, ledger_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
      [req.user.id, method, dest, amt, usd, isFirst ? 1 : 0, debit.id, now, now]
    );
    if (isFirst) {
      db.run('UPDATE users SET first_cashout_at = ? WHERE id = ? AND first_cashout_at IS NULL', [now, req.user.id]);
    }
    const row = db.get('SELECT * FROM cashouts WHERE id = ?', [r.lastInsertRowid]);
    res.json({ ok: true, cashout: row, balance: ledger.balanceOf(db, req.user.id) });
  });

  app.get('/api/cashouts', auth, (req, res) => {
    const rows = db.all('SELECT * FROM cashouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    res.json({ cashouts: rows });
  });

  function handlePostback(req, res) {
    const key = String(req.params.partner || '').toLowerCase();
    try {
      const out = ingest({ partnerKey: key, req, query: Object.assign({}, req.query, req.body) });
      res.status(200).json({ ok: true, action: out.action, idempotent: out.idempotent });
    } catch (e) {
      const code = e.http || 400;
      res.status(code).json({ ok: false, error: e.message });
    }
  }
  app.get('/postback/:partner', postbackLimit, handlePostback);
  app.post('/postback/:partner', postbackLimit, handlePostback);

  // ----- admin -----
  const adminSessions = new Map();
  function adminOk(req) {
    const tok = (req.get('x-admin-token') || req.query.adminToken || (req.body && req.body.adminToken) || '');
    const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('goody_admin='));
    const cv = cookie ? decodeURIComponent(cookie.split('=')[1]) : '';
    const token = tok || cv;
    if (!token) return false;
    if (adminSessions.has(token)) return true;
    const row = db.get('SELECT * FROM admin_sessions WHERE token = ?', [token]);
    return !!row;
  }

  app.post('/admin/login', sessionLimit, (req, res) => {
    const pw = (req.body && req.body.password) || '';
    if (!cfg.adminPassword || pw !== cfg.adminPassword) {
      return res.status(401).json({ error: 'Wrong password' });
    }
    const token = require('crypto').randomBytes(24).toString('hex');
    adminSessions.set(token, Date.now());
    db.run('INSERT INTO admin_sessions (token, created_at) VALUES (?, ?)', [token, isoNow()]);
    res.setHeader('Set-Cookie', `goody_admin=${token}; Path=/; HttpOnly; SameSite=Lax`);
    res.json({ ok: true, token });
  });

  function requireAdmin(req, res, next) {
    if (!adminOk(req)) return res.status(401).json({ error: 'Admin sign-in required' });
    next();
  }

  app.get('/admin/api/users', requireAdmin, (_req, res) => {
    const users = db.all('SELECT id, public_id, device_id, created_at, first_cashout_at, last_seen_at FROM users ORDER BY id DESC LIMIT 200');
    const out = users.map((u) => ({ ...u, balance: ledger.balanceOf(db, u.id) }));
    res.json({ users: out });
  });

  app.get('/admin/api/ledger', requireAdmin, (req, res) => {
    const userId = req.query.userId;
    const rows = userId
      ? db.all('SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 300', [userId])
      : db.all('SELECT * FROM ledger ORDER BY id DESC LIMIT 300');
    res.json({ entries: rows });
  });

  app.get('/admin/api/cashouts', requireAdmin, (_req, res) => {
    res.json({ cashouts: db.all('SELECT * FROM cashouts ORDER BY id DESC LIMIT 200') });
  });

  app.post('/admin/api/cashouts/:id/approve', requireAdmin, (req, res) => {
    const row = db.get('SELECT * FROM cashouts WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'requested') return res.status(400).json({ error: 'This cash out is already ' + row.status });
    db.run('UPDATE cashouts SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?', [
      'approved', (req.body && req.body.note) || row.admin_note, isoNow(), row.id
    ]);
    res.json({ ok: true, cashout: db.get('SELECT * FROM cashouts WHERE id = ?', [row.id]) });
  });

  app.post('/admin/api/cashouts/:id/sent', requireAdmin, (req, res) => {
    const row = db.get('SELECT * FROM cashouts WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'approved' && row.status !== 'requested') {
      return res.status(400).json({ error: 'This cash out is already ' + row.status });
    }
    db.run('UPDATE cashouts SET status = ?, updated_at = ? WHERE id = ?', ['sent', isoNow(), row.id]);
    if (row.ledger_id) ledger.settleDebit(db, row.ledger_id, 'paid');
    res.json({ ok: true, cashout: db.get('SELECT * FROM cashouts WHERE id = ?', [row.id]) });
  });

  app.post('/admin/api/cashouts/:id/reject', requireAdmin, (req, res) => {
    const row = db.get('SELECT * FROM cashouts WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status === 'sent') return res.status(400).json({ error: 'Already sent' });
    db.run('UPDATE cashouts SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?', [
      'rejected', (req.body && req.body.note) || 'rejected', isoNow(), row.id
    ]);
    if (row.ledger_id) ledger.settleDebit(db, row.ledger_id, 'rejected');
    res.json({ ok: true, cashout: db.get('SELECT * FROM cashouts WHERE id = ?', [row.id]) });
  });

  app.use(express.static(PUBLIC));
  app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/postback') || req.path.startsWith('/admin')) return next();
    res.sendFile(path.join(PUBLIC, 'index.html'));
  });

  app.locals.db = db;
  app.locals.config = cfg;
  app.locals.ingest = ingest;
  app.locals.sim = sim;
  app.locals.ledger = ledger;
  app.close = () => {
    sim.close();
    if (db.saveNow) db.saveNow();
  };
  return app;
}

module.exports = { createApp, offerView, methodMinUsd };
